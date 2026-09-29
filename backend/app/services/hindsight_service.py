from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.config import get_settings
from app.database.database import Base, engine
from app.database.models import IncidentRecord


class HindsightService:
    """Local Hindsight adapter.

    This keeps the Hindsight integration isolated and intentionally avoids claiming a
    remote official SDK/API contract where that was not verified in this environment.
    The service exposes the conceptual Hindsight operations requested by the project,
    while using the local SQLite database as the persistent memory layer.
    """

    def __init__(self, db: Session | None = None):
        self.db = db
        self.settings = get_settings()

    def is_available(self) -> bool:
        return True

    def recall_memories(self, query: str, limit: int = 5):
        return self.recall_relevant_incidents(query, limit=limit)

    def _ensure_db(self):
        Base.metadata.create_all(bind=engine)
        if self.db is None:
            from app.database.database import SessionLocal

            self.db = SessionLocal()

    def store_incident_memory(self, incident_data: dict[str, Any]) -> dict[str, Any]:
        self._ensure_db()
        incident = IncidentRecord(
            incident_id=incident_data["incident_id"],
            title=incident_data["title"],
            service=incident_data["service"],
            severity=incident_data["severity"],
            status=incident_data.get("status", "OPEN"),
            symptoms=incident_data.get("symptoms", ""),
            error_logs=incident_data.get("error_logs", ""),
            affected_components=incident_data.get("affected_components", ""),
            deployment_version=incident_data.get("deployment_version", ""),
            environment=incident_data.get("environment", "production"),
            root_cause=incident_data.get("root_cause", ""),
            investigation_steps=incident_data.get("investigation_steps", ""),
            actions_taken=incident_data.get("actions_taken", ""),
            runbook_used=incident_data.get("runbook_used", ""),
            resolution=incident_data.get("resolution", ""),
            resolution_time=incident_data.get("resolution_time", 0),
            successful=incident_data.get("successful", False),
            postmortem=incident_data.get("postmortem", ""),
            lessons_learned=incident_data.get("lessons_learned", ""),
            similarity_summary=incident_data.get("similarity_summary", ""),
            memory_context=json.dumps(incident_data.get("memory_context", {}), default=str),
            confidence=incident_data.get("confidence", 0.0),
        )
        self.db.add(incident)
        self.db.commit()
        self.db.refresh(incident)
        return {"status": "stored", "incident_id": incident.incident_id}

    def recall_relevant_incidents(self, query: str, limit: int = 5):
        self._ensure_db()
        incidents = self.db.query(IncidentRecord).all()
        ordered = []
        stop_words = {
            "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "get", "getting",
            "has", "have", "http", "in", "is", "it", "of", "on", "or", "our", "the", "to", "was",
            "were", "with", "error", "errors", "failure", "failures", "reported", "incident", "service",
            "production", "staging", "development", "after", "during", "user", "users",
        }

        def tokens(value: str) -> set[str]:
            result = set()
            for token in re.findall(r"[a-z0-9]+", (value or "").lower()):
                if len(token) < 3 or token in stop_words:
                    continue
                result.add(token[:-1] if token.endswith("s") and len(token) > 4 else token)
            return result

        query_tokens = tokens(query)
        for incident in incidents:
            service_tokens = tokens(incident.service or "")
            text = " ".join(
                [
                    incident.title or "",
                    incident.service or "",
                    incident.symptoms or "",
                    incident.error_logs or "",
                    incident.root_cause or "",
                    incident.actions_taken or "",
                    incident.runbook_used or "",
                    incident.lessons_learned or "",
                ]
            )
            overlap = query_tokens.intersection(tokens(text))
            service_overlap = query_tokens.intersection(service_tokens)
            if not query_tokens or service_overlap or len(overlap) >= 2:
                score = len(overlap) + (4 * len(service_overlap))
                ordered.append({
                    "incident_id": incident.incident_id,
                    "service": incident.service,
                    "title": incident.title,
                    "symptoms": incident.symptoms,
                    "root_cause": incident.root_cause,
                    "runbook_used": incident.runbook_used,
                    "resolution": incident.resolution,
                    "resolution_time": incident.resolution_time,
                    "lessons_learned": incident.lessons_learned,
                    "successful": incident.successful,
                    "status": incident.status,
                    "confidence": min(0.98, round(score / max(1, len(query_tokens) + 4), 2)),
                    "_score": score,
                    "date": incident.created_at,
                })
        ordered.sort(key=lambda item: (item["_score"], item["successful"], item["confidence"]), reverse=True)
        for item in ordered:
            item.pop("_score", None)
        return ordered[:limit]

    def list_incidents(self):
        self._ensure_db()
        return self.db.query(IncidentRecord).order_by(IncidentRecord.created_at.desc()).all()

    def get_incident_by_id(self, incident_id: str):
        self._ensure_db()
        return self.db.query(IncidentRecord).filter(IncidentRecord.incident_id == incident_id).first()

    def get_memories(self):
        self._ensure_db()
        incidents = self.db.query(IncidentRecord).all()
        memories = []
        for incident in incidents:
            memories.append({
                "incident_id": incident.incident_id,
                "title": incident.title,
                "service": incident.service,
                "symptoms": incident.symptoms,
                "root_cause": incident.root_cause,
                "runbook_used": incident.runbook_used,
                "resolution": incident.resolution,
                "resolution_time": incident.resolution_time,
                "lessons_learned": incident.lessons_learned,
                "similarity": 0.86,
            })
        return memories
