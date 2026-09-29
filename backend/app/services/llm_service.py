from __future__ import annotations

import json
from typing import Any

import httpx

from app.config import get_settings


class LLMService:
    def __init__(self):
        self.settings = get_settings()

    def _fallback_response(self, incident_data: dict[str, Any]) -> dict[str, Any]:
        service = incident_data.get("service", "service")
        symptoms = incident_data.get("symptoms", "")
        evidence = incident_data.get("error_logs", "")
        combined = f"{symptoms} {evidence}".lower()
        possible_root_causes = []
        if any(token in combined for token in ("deploy", "deployment", "release", "rollback")):
            possible_root_causes.append("A deployment-related regression is possible; verify the change window and rollout health.")
        if any(token in combined for token in ("database", "db", "connection pool", "postgres", "mysql")):
            possible_root_causes.append("Database dependency or connection-pool pressure is possible; confirm with pool and database metrics.")
        if any(token in combined for token in ("503", "5xx", "unavailable", "overload")):
            possible_root_causes.append("An unavailable or overloaded service dependency is possible; confirm with upstream health and saturation metrics.")
        if not possible_root_causes:
            possible_root_causes.append("The available report does not identify a root cause yet; collect service and dependency health evidence.")

        if "database" in combined or "connection pool" in combined or "postgres" in combined or "mysql" in combined:
            runbook = "CHECK_DATABASE_CONNECTIONS"
        elif "deploy" in combined or "release" in combined:
            runbook = "CHECK_DEPLOYMENT_HEALTH"
        elif "503" in combined or "5xx" in combined:
            runbook = "CHECK_SERVICE_HEALTH"
        else:
            runbook = "GENERAL_INCIDENT_TRIAGE"
        return {
            "summary": f"The report for {service} describes: {symptoms}. No cause is confirmed by the available data.",
            "possible_root_causes": possible_root_causes,
            "confidence": 0.45,
            "recommended_runbook": runbook,
            "recommendation": "Treat listed causes as hypotheses. Verify against telemetry and historical incidents before taking action.",
        }

    async def analyze_incident(self, incident_data: dict[str, Any]) -> dict[str, Any]:
        if not self.settings.groq_api_key:
            return self._fallback_response(incident_data)

        payload = {
            "model": "llama-3.1-8b-instant",
            "messages": [
                {
                    "role": "system",
                    "content": "You are Sentinel, an incident response assistant. Use only the supplied incident facts. Never present a possible root cause as confirmed, never invent historical incidents, resolutions, evidence, or runbooks, and say when information is unavailable. Respond with concise JSON: summary, possible_root_causes (list of hypotheses), confidence (0-1), recommended_runbook, recommendation.",
                },
                {
                    "role": "user",
                    "content": json.dumps(incident_data, default=str),
                },
            ],
            "temperature": 0.2,
        }

        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.settings.groq_api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
                response.raise_for_status()
                content = response.json()
                text = content["choices"][0]["message"]["content"]
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return self._fallback_response(incident_data)
        except Exception:
            return self._fallback_response(incident_data)
