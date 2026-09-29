from __future__ import annotations

from app.services.hindsight_service import HindsightService
from app.services.llm_service import LLMService


class InvestigationService:
    def __init__(self, db=None):
        self.llm_service = LLMService()
        self.hindsight_service = HindsightService(db)

    async def investigate(self, incident_data: dict) -> dict:
        analysis = await self.llm_service.analyze_incident(incident_data)
        query = f"{incident_data.get('service', '')} {incident_data.get('symptoms', '')} {incident_data.get('error_logs', '')}"
        similar = self.hindsight_service.recall_relevant_incidents(query, limit=5)

        return {
            "incident_summary": analysis.get("summary", "Investigation started."),
            "possible_root_causes": analysis.get("possible_root_causes", []),
            "historical_matches": similar,
            "hindsight_memory": similar,
            "evidence": [
                {"source": "Operations Memory", "detail": f"Matched {len(similar)} previous incidents by service and symptoms." if similar else "No similar incident was found in Operations Memory."},
                {"source": "LLM analysis", "detail": analysis.get("recommendation", "Environment check is recommended.")},
            ],
            "recommended_actions": [
                "Check dependency metrics and deployment logs.",
                "Verify recent rollout changes for the service.",
                "Compare to previously resolved incidents in memory.",
            ],
            "recommended_runbook": analysis.get("recommended_runbook", "CHECK_DEPLOYMENT_HEALTH"),
            "confidence": analysis.get("confidence", 0.7),
            "memory_status": "Memory service unavailable" if not self.hindsight_service.is_available() else "Memory retrieved successfully",
        }
