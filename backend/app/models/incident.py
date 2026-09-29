from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class Severity(str, Enum):
    SEV_1 = "SEV-1"
    SEV_2 = "SEV-2"
    SEV_3 = "SEV-3"
    SEV_4 = "SEV-4"


class IncidentStatus(str, Enum):
    OPEN = "OPEN"
    INVESTIGATING = "INVESTIGATING"
    RESOLVED = "RESOLVED"


class IncidentCreate(BaseModel):
    incident_id: Optional[str] = None
    service: str = Field(..., min_length=2)
    severity: Severity = Severity.SEV_2
    title: str = Field(..., min_length=3)
    description: str = ""
    symptoms: str = Field(..., min_length=5)
    error_logs: str = ""
    deployment_version: str = ""
    timestamp: Optional[datetime] = None
    status: IncidentStatus = IncidentStatus.OPEN
    root_cause: str = ""
    investigation_steps: str = ""
    runbook: str = ""
    actions_taken: str = ""
    resolution: str = ""
    runbook_used: str = ""
    resolution_time_minutes: int = 0
    resolution_time: int = 0
    successful: bool = False
    postmortem: str = ""
    lessons_learned: str = ""
    affected_components: str = ""
    environment: str = "production"

    @field_validator("severity")
    @classmethod
    def validate_severity(cls, value):
        if value not in Severity:
            raise ValueError("Invalid severity provided")
        return value


class IncidentOut(BaseModel):
    incident_id: str
    service: str
    severity: str
    title: str
    description: str = ""
    symptoms: str
    error_logs: str
    deployment_version: str = ""
    timestamp: Optional[datetime] = None
    status: str
    root_cause: str = ""
    investigation_steps: str = ""
    runbook: str = ""
    actions_taken: str = ""
    resolution: str = ""
    runbook_used: str = ""
    resolution_time_minutes: int = 0
    resolution_time: int = 0
    successful: bool = False
    postmortem: str = ""
    lessons_learned: str = ""
    affected_components: str = ""
    environment: str = "production"
    created_at: datetime | None = None
    resolved_at: Optional[datetime] = None
    confidence: float = 0.0


class InvestigationRequest(BaseModel):
    incident_id: str


class Recommendation(BaseModel):
    recommendation: str
    why: str
    historical_evidence: str
    related_incident_ids: list[str] = []
    previous_root_cause: str = ""
    recommended_runbook: str = ""
    expected_benefit: str = ""
    warning: str = ""
    confidence: float = 0.0
