from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database.database import get_db
from app.services.agent_service import AgentService

router = APIRouter(prefix="/api/agent", tags=["agent"])


class AgentChatRequest(BaseModel):
    message: str
    context: dict[str, Any] | None = None
    incident_id: str | None = None


@router.post("/chat")
async def chat_with_agent(payload: AgentChatRequest, db: Session = Depends(get_db)):
    if not payload.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    return await AgentService().build_agent_response(
        payload.message,
        db=db,
        context=payload.context,
        incident_id=payload.incident_id,
    )