from __future__ import annotations

import re
from typing import Any

from sqlalchemy.orm import Session

from app.database.models import IncidentRecord
from app.services.hindsight_service import HindsightService
from app.services.investigation_service import InvestigationService


class AgentService:
    environment_terms = {
        "production": "production",
        "prod": "production",
        "staging": "staging",
        "stage": "staging",
        "development": "development",
        "dev": "development",
    }

    @classmethod
    def _extract_environment(cls, message: str) -> str:
        text = message.lower()
        return next((value for token, value in cls.environment_terms.items() if re.search(rf"\b{token}\b", text)), "")

    @staticmethod
    def _extract_service(message: str) -> str:
        patterns = (
            r"\b(?:our|the)\s+([a-z][a-z0-9._/-]*(?:\s+[a-z][a-z0-9._/-]*){0,3})\s+(?:is|are|was|were)\s+(?:down|broken|failing|degraded|unavailable|not responding)\b",
            r"\b([a-z][a-z0-9._/-]*(?:\s+[a-z][a-z0-9._/-]*){0,3})\s+(?:is|are|was|were)\s+(?:down|broken|failing|degraded|unavailable|not responding)\b",
            r"\b(?:service|system|app|application|api)\s*[:=]?\s+([a-z][a-z0-9._/-]*(?:\s+[a-z][a-z0-9._/-]*){0,3})",
        )
        for pattern in patterns:
            match = re.search(pattern, message, flags=re.IGNORECASE)
            if match:
                service = match.group(1).strip(" -:;,.")
                if service.lower() not in {"is", "are", "was", "were"}:
                    return service
        return ""

    @staticmethod
    def _extract_evidence(message: str) -> str:
        findings = []
        status_codes = sorted(set(re.findall(r"\b(?:http\s*)?(5\d\d)\b", message, flags=re.IGNORECASE)))
        if status_codes:
            findings.append(f"HTTP {', '.join(status_codes)} errors")
        patterns = (
            (r"\btimeout(?:s|ting)?\b", "request timeouts"),
            (r"\blatency\b", "latency impact reported"),
            (r"\bexception(?:s)?\b", "exceptions reported"),
            (r"\b(?:error|errors|failing|failure|failures)\b", "errors reported"),
            (r"\b(?:deploy|deployment|release|rollback)\b", "deployment activity reported"),
        )
        for pattern, label in patterns:
            if re.search(pattern, message, flags=re.IGNORECASE) and label not in findings:
                findings.append(label)
        return "; ".join(findings)

    @staticmethod
    def _extract_optional_details(message: str) -> tuple[str, str]:
        version_match = re.search(r"\b(?:deployment\s+)?version\s+([A-Za-z0-9][A-Za-z0-9._-]*)\b", message, re.IGNORECASE)
        component_match = re.search(r"\baffected\s+components?\s*[:=]\s*([^.;\n]+)", message, re.IGNORECASE)
        return (version_match.group(1) if version_match else "", component_match.group(1).strip() if component_match else "")

    @staticmethod
    def _extract_severity(message: str) -> tuple[str, str]:
        text = message.lower()
        explicit = re.search(r"\bsev(?:erity)?[- ]?([1-4])\b", text)
        if explicit:
            return f"SEV-{explicit.group(1)}", "explicitly stated in the report"
        if any(term in text for term in ("complete outage", "is down", "outage", "503", "critical")):
            return "SEV-1", "suggested from reported outage or 5xx impact"
        if any(term in text for term in ("major impact", "degraded", "high severity")):
            return "SEV-2", "suggested from reported service degradation"
        if any(term in text for term in ("intermittent", "partial issue", "minor impact")):
            return "SEV-3", "suggested from reported intermittent or partial impact"
        return "SEV-2", "default triage level; confirm impact with the incident commander"

    @staticmethod
    def _is_yes(message: str) -> bool:
        return bool(re.match(r"^(yes|yeah|yep|correct|please do|go ahead|do it|confirm|investigate|create it|create(?: the)? incident)\b", message.strip(), re.IGNORECASE))

    @staticmethod
    def _is_no(message: str) -> bool:
        return bool(re.match(r"^(no|no thanks|not now|cancel|don't|do not)\b", message.strip(), re.IGNORECASE))

    @staticmethod
    def _record_summary(incident: IncidentRecord) -> dict[str, Any]:
        return {
            "incident_id": incident.incident_id,
            "title": incident.title,
            "service": incident.service,
            "severity": incident.severity,
            "status": incident.status,
            "environment": incident.environment,
            "symptoms": incident.symptoms,
            "error_logs": incident.error_logs,
            "affected_components": incident.affected_components,
            "deployment_version": incident.deployment_version,
            "root_cause": incident.root_cause,
            "resolution": incident.resolution,
            "runbook_used": incident.runbook_used,
            "successful": incident.successful,
        }

    @staticmethod
    def _same_service(left: str, right: str) -> bool:
        ignored = {"api", "app", "service", "system"}

        def normalized(value: str) -> set[str]:
            words = {word for word in re.findall(r"[a-z0-9]+", (value or "").lower()) if word not in ignored}
            return {word[:-1] if word.endswith("s") and len(word) > 4 else word for word in words}

        left_words = normalized(left)
        right_words = normalized(right)
        overlap = left_words.intersection(right_words)
        return bool(overlap) and (len(overlap) >= 2 or left_words <= right_words or right_words <= left_words)

    async def build_agent_response(
        self,
        message: str,
        db: Session,
        context: dict[str, Any] | None = None,
        incident_id: str | None = None,
    ) -> dict[str, Any]:
        message = (message or "").strip()
        current_context = context or {}
        awaiting = current_context.get("awaiting", "")
        candidate = dict(current_context.get("candidate") or {})

        if not message:
            return {"kind": "clarification", "message": "Tell me what service is affected and what users or monitoring are seeing.", "context": current_context}

        if awaiting in {"investigation_confirmation", "create_confirmation"}:
            if self._is_no(message):
                return {"kind": "message", "message": "Understood. I have not created or changed an incident.", "context": {}}
            if awaiting == "create_confirmation" and self._is_yes(message):
                return {
                    "kind": "create_request",
                    "message": "I’m creating this incident in the existing incident register now.",
                    "candidate": candidate,
                    "context": {"candidate": candidate, "awaiting": "create_confirmation"},
                }
            if awaiting == "investigation_confirmation" and self._is_yes(message):
                return await self._investigate_candidate(candidate, db)
            if awaiting == "investigation_confirmation" and re.search(r"\bcreate\b", message, re.IGNORECASE):
                return await self._investigate_candidate(candidate, db, create_after_investigation=True)
            if awaiting == "investigation_confirmation" and re.search(r"\b(similar|root cause|resolution|runbook|why|what happened|investigate)\b", message, re.IGNORECASE):
                return await self._investigate_candidate(candidate, db)
            if awaiting == "create_confirmation":
                return self._answer_followup(message, current_context)
            return {
                "kind": "clarification",
                "message": "Would you like me to investigate this report against Operations Memory? Reply yes or no.",
                "detected_incident": candidate,
                "context": current_context,
            }

        if awaiting == "active_incident_choice":
            active_id = current_context.get("active_incident_id")
            if re.search(r"\b(update|add|attach|existing)\b", message, re.IGNORECASE):
                return {
                    "kind": "update_request",
                    "message": f"I’m adding this report to the response timeline for {active_id}.",
                    "incident_id": active_id,
                    "detail": candidate.get("symptoms", message),
                    "context": current_context,
                }
            if re.search(r"\b(create|separate|new incident)\b", message, re.IGNORECASE):
                return {"kind": "create_request", "message": "Understood. I’ll create a separate incident in the shared register.", "candidate": candidate, "context": current_context}
            if self._is_no(message):
                return {"kind": "message", "message": "No changes made. The existing incident remains unchanged.", "context": {}}
            if re.search(r"\b(root cause|cause|resolution|runbook|similar|history|previous|why)\b", message, re.IGNORECASE):
                answer = self._answer_followup(message, current_context)
                answer["message"] = answer["message"].replace("Would you like me to create this incident in the shared incident register?", f"Would you like me to update {active_id} or create a separate incident?")
                return answer
            return {
                "kind": "clarification",
                "message": f"I found active incident {active_id} for this service. Should I add this report to that incident, or create a separate incident?",
                "detected_incident": candidate,
                "context": current_context,
            }

        selected_id = incident_id or current_context.get("incident_id")
        message_id = re.search(r"\bINC-[A-Z0-9-]+\b", message, re.IGNORECASE)
        selected_id = message_id.group(0).upper() if message_id else selected_id
        if selected_id:
            incident = db.query(IncidentRecord).filter(IncidentRecord.incident_id == selected_id).first()
            if not incident:
                return {"kind": "message", "message": f"I couldn’t find incident {selected_id} in the incident register. Please check the ID and try again.", "context": {}}
            payload = {
                "service": incident.service,
                "severity": incident.severity,
                "title": incident.title,
                "symptoms": incident.symptoms or "",
                "error_logs": incident.error_logs or "",
                "environment": incident.environment or "",
                "deployment_version": incident.deployment_version or "",
            }
            result = await InvestigationService(db=db).investigate(payload)
            matches = [item for item in result.get("historical_matches", []) if item.get("incident_id") != incident.incident_id]
            return self._investigation_result(
                result,
                self._record_summary(incident),
                matches,
                context={"incident_id": incident.incident_id, "mode": "existing_incident"},
                existing=True,
            )

        lowered = message.lower()
        if any(phrase in lowered for phrase in ("check active incidents", "show active incidents", "list active incidents", "investigate an existing incident")):
            records = db.query(IncidentRecord).filter(IncidentRecord.status != "RESOLVED").order_by(IncidentRecord.created_at.desc()).all()
            return {
                "kind": "incident_list",
                "message": "Here are the active incidents in the shared incident register. Choose one to investigate.",
                "incidents": [self._record_summary(record) for record in records],
                "context": {},
            }

        if "report an incident" in lowered and len(message) < 45:
            return {"kind": "clarification", "message": "Describe what happened, which service is affected, and what environment it is in. I’ll ask only for details that are still missing.", "context": {"awaiting": "report_details"}}

        if awaiting in {"service", "environment", "symptoms"}:
            if awaiting == "service" and not candidate.get("service"):
                candidate["service"] = message.strip().rstrip(".!?")
            elif awaiting == "environment":
                environment = self._extract_environment(message)
                if environment:
                    candidate["environment"] = environment
            elif awaiting == "symptoms":
                candidate["symptoms"] = message
                candidate["error_logs"] = self._extract_evidence(message)

        extracted_service = self._extract_service(message)
        if extracted_service:
            candidate["service"] = extracted_service
        environment = self._extract_environment(message)
        if environment:
            candidate["environment"] = environment
        evidence = self._extract_evidence(message)
        if evidence:
            candidate["error_logs"] = evidence
        if message and awaiting not in {"service", "environment"} and not candidate.get("symptoms"):
            candidate["symptoms"] = message
        elif message and awaiting not in {"service", "environment"} and extracted_service and candidate.get("symptoms") != message:
            candidate["symptoms"] = message
        version, components = self._extract_optional_details(message)
        if version:
            candidate["deployment_version"] = version
        if components:
            candidate["affected_components"] = components

        if candidate.get("symptoms"):
            severity, severity_reason = self._extract_severity(candidate["symptoms"])
            candidate.setdefault("severity", severity)
            candidate["severity_reason"] = candidate.get("severity_reason") or severity_reason
            candidate.setdefault("error_logs", self._extract_evidence(candidate["symptoms"]))
        candidate["title"] = candidate.get("title") or (f"{candidate['service']} incident" if candidate.get("service") else "Incident report")

        if not candidate.get("service"):
            return {"kind": "clarification", "message": "Which service or system is affected?", "context": {"candidate": candidate, "awaiting": "service"}}
        if not candidate.get("environment"):
            return {
                "kind": "clarification",
                "message": "Is this affecting production, staging, or development?",
                "detected_incident": candidate,
                "context": {"candidate": candidate, "awaiting": "environment"},
            }
        if not candidate.get("symptoms") or len(candidate["symptoms"].strip()) < 5:
            return {"kind": "clarification", "message": "What are users or monitoring seeing? A short description is enough; logs are optional.", "context": {"candidate": candidate, "awaiting": "symptoms"}}

        severity, severity_reason = self._extract_severity(candidate["symptoms"])
        candidate.setdefault("severity", severity)
        candidate["severity_reason"] = candidate.get("severity_reason") or severity_reason
        candidate.setdefault("error_logs", self._extract_evidence(candidate["symptoms"]))
        candidate.setdefault("deployment_version", "")
        candidate.setdefault("affected_components", "")
        return {
            "kind": "detected_incident",
            "message": f"I detected a possible {candidate['environment']} incident affecting {candidate['service']}. Would you like me to investigate it against Operations Memory?",
            "detected_incident": candidate,
            "context": {"candidate": candidate, "awaiting": "investigation_confirmation"},
        }

    async def _investigate_candidate(
        self,
        candidate: dict[str, Any],
        db: Session,
        create_after_investigation: bool = False,
    ) -> dict[str, Any]:
        payload = {
            "service": candidate["service"],
            "severity": candidate.get("severity", "SEV-2"),
            "title": candidate.get("title", f"{candidate['service']} incident"),
            "symptoms": candidate["symptoms"],
            "error_logs": candidate.get("error_logs", ""),
            "environment": candidate["environment"],
            "deployment_version": candidate.get("deployment_version", ""),
        }
        result = await InvestigationService(db=db).investigate(payload)
        matches = result.get("historical_matches", [])
        active_match = next((
            item for item in matches
            if item.get("status") != "RESOLVED" and self._same_service(candidate["service"], item.get("service", ""))
        ), None)
        if active_match:
            context = {
                "candidate": candidate,
                "awaiting": "active_incident_choice",
                "active_incident_id": active_match["incident_id"],
                "investigation": result,
                "matches": matches,
            }
        else:
            context = {"candidate": candidate, "awaiting": "create_confirmation", "investigation": result, "matches": matches}
        return self._investigation_result(
            result,
            candidate,
            matches,
            context=context,
            active_incident=active_match,
            create_after_investigation=create_after_investigation,
        )

    @staticmethod
    def _answer_followup(message: str, context: dict[str, Any]) -> dict[str, Any]:
        lowered = message.lower()
        result = context.get("investigation") or {}
        matches = context.get("matches") or []
        best = matches[0] if matches else None
        successful = next((item for item in matches if item.get("successful") and item.get("resolution")), None)
        if re.search(r"\b(root cause|cause|why)\b", lowered):
            if best and best.get("root_cause"):
                answer = f"The closest historical match, {best['incident_id']}, records this root cause: {best['root_cause']} This is evidence from that prior incident, not a confirmed cause for the current report."
            elif result.get("possible_root_causes"):
                answer = "The investigation has only hypotheses, not a confirmed cause: " + "; ".join(result["possible_root_causes"])
            else:
                answer = "No root cause is recorded in the available incident history, and the current report does not establish one."
        elif re.search(r"\b(resolution|resolved|fixed|how did .* recover)\b", lowered):
            answer = f"Successful historical resolution from {successful['incident_id']}: {successful['resolution']}" if successful else "No successful previous resolution is recorded in the matching incident history."
        elif re.search(r"\b(runbook|playbook)\b", lowered):
            runbook_match = successful or next((item for item in matches if item.get("runbook_used")), best)
            answer = f"The closest stored runbook is {runbook_match['runbook_used']} from {runbook_match['incident_id']}." if runbook_match and runbook_match.get("runbook_used") else "No runbook is recorded for the matching historical incidents."
        elif re.search(r"\b(similar|previous|history|historical)\b", lowered):
            answer = f"I found {len(matches)} matching historical incident{'s' if len(matches) != 1 else ''}: " + ", ".join(item["incident_id"] for item in matches) if matches else "No similar incident was found in Operations Memory."
        else:
            summary = result.get("incident_summary") or "I have not confirmed a root cause from the available evidence."
            answer = f"{summary} I can answer questions about the stored matches, their resolutions, and recorded runbooks."
        return {
            "kind": "message",
            "message": f"{answer} Would you like me to create this incident in the shared incident register?",
            "context": context,
        }

    @staticmethod
    def _investigation_result(
        result: dict[str, Any],
        incident: dict[str, Any],
        matches: list[dict[str, Any]],
        context: dict[str, Any],
        existing: bool = False,
        active_incident: dict[str, Any] | None = None,
        create_after_investigation: bool = False,
    ) -> dict[str, Any]:
        successful = next((item for item in matches if item.get("successful") and item.get("resolution")), None)
        stored_runbook = next((item.get("runbook_used") for item in matches if item.get("runbook_used")), "")
        reported_evidence = []
        for label, key in (("Reported symptoms", "symptoms"), ("Reported logs and alerts", "error_logs")):
            detail = incident.get(key)
            if detail:
                reported_evidence.append({"source": "Incident record" if existing else "Employee report", "label": label, "detail": detail})
        memory_evidence = [item for item in result.get("evidence", []) if item.get("source") == "Operations Memory"]
        if matches:
            closest = matches[0]
            message = f"I found {len(matches)} similar incident{'s' if len(matches) != 1 else ''} in Operations Memory. The closest match is {closest['incident_id']}."
        else:
            closest = None
            message = "No similar incident was found in Operations Memory."
        if existing:
            message = f"I investigated {incident['incident_id']}. {message}"
        elif not existing:
            message = f"{result.get('incident_summary') or 'Investigation complete.'} {message}"
            if active_incident:
                message = f"{message} An active incident already exists for this service: {active_incident['incident_id']}. I won't create a duplicate without your direction. Would you like me to update that incident or create a separate one?"
            else:
                message += " Would you like me to create this incident in the shared incident register?"

        response = {
            "kind": "investigation",
            "message": message,
            "detected_incident": incident,
            "investigation": {
                "summary": result.get("incident_summary") or "Investigation complete.",
                "possible_root_causes": result.get("possible_root_causes") or [],
                "evidence": reported_evidence + memory_evidence,
                "similar_incidents": matches,
                "previous_resolution": successful.get("resolution") if successful else (closest.get("resolution") if closest else ""),
                "recommended_runbook": (successful or {}).get("runbook_used") or stored_runbook or result.get("recommended_runbook") or "",
                "confidence": result.get("confidence"),
                "severity_reason": incident.get("severity_reason", ""),
                "active_incident": active_incident,
            },
            "similar_incidents": matches,
            "context": context,
            "create_available": not existing and not active_incident,
        }
        if existing:
            response["incident_id"] = incident["incident_id"]
        if create_after_investigation and not existing:
            response["kind"] = "create_request"
            response["message"] = "The investigation is complete. You confirmed creation, so I’m adding the incident to the shared register."
            response["candidate"] = incident
        return response