from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database.database import Base, get_db
from app.database.models import IncidentRecord
from app.main import app


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client, session_factory
    app.dependency_overrides.clear()
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


def test_conversation_uses_real_memory_and_requires_create_confirmation(client):
    test_client, session_factory = client
    db = session_factory()
    db.add(IncidentRecord(
        incident_id="INC-1020",
        title="Payment API 503 errors",
        service="payments-api",
        severity="SEV-1",
        status="RESOLVED",
        symptoms="Payment requests returned HTTP 503 during peak traffic.",
        error_logs="Connection pool exhausted",
        root_cause="Database connection pool exhaustion",
        resolution="Restarted payment service and increased the connection pool.",
        runbook_used="DB-CONNECTION-RECOVERY",
        successful=True,
        created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()

    memory = test_client.post("/api/memory/search", json={"query": "payments 503 database"})
    assert memory.status_code == 200
    assert memory.json()["memories"][0]["incident_id"] == "INC-1020"

    first = test_client.post("/api/agent/chat", json={
        "message": "Payment API is down in production. We're getting 503 errors.",
    })
    assert first.status_code == 200
    detected = first.json()
    assert detected["kind"] == "detected_incident"
    assert detected["detected_incident"]["service"] == "Payment API"
    assert detected["detected_incident"]["environment"] == "production"
    assert "503" in detected["detected_incident"]["error_logs"]

    investigated = test_client.post("/api/agent/chat", json={
        "message": "Yes, investigate",
        "context": detected["context"],
    })
    assert investigated.status_code == 200
    result = investigated.json()
    assert result["kind"] == "investigation"
    assert result["similar_incidents"][0]["incident_id"] == "INC-1020"
    assert result["investigation"]["previous_resolution"] == "Restarted payment service and increased the connection pool."
    assert result["investigation"]["recommended_runbook"] == "DB-CONNECTION-RECOVERY"
    assert result["context"]["awaiting"] == "create_confirmation"

    existing = test_client.post("/api/agent/chat", json={
        "message": "Investigate INC-1020",
        "incident_id": "INC-1020",
    })
    assert existing.status_code == 200
    assert existing.json()["incident_id"] == "INC-1020"
    assert existing.json()["create_available"] is False
    assert all(item["incident_id"] != "INC-1020" for item in existing.json()["similar_incidents"])

    followup = test_client.post("/api/agent/chat", json={
        "message": "What was the previous root cause?",
        "context": result["context"],
    })
    assert "Database connection pool exhaustion" in followup.json()["message"]
    assert followup.json()["context"]["awaiting"] == "create_confirmation"

    confirmation = test_client.post("/api/agent/chat", json={
        "message": "Create incident",
        "context": result["context"],
    })
    assert confirmation.status_code == 200
    assert confirmation.json()["kind"] == "create_request"

    created = test_client.post("/api/incidents", json={
        **confirmation.json()["candidate"],
        "status": "INVESTIGATING",
    })
    assert created.status_code == 200, created.text
    created_incident = created.json()
    assert created_incident["incident_id"].startswith("INC-")
    assert created_incident["status"] == "INVESTIGATING"

    incident_list = test_client.get("/api/incidents")
    assert incident_list.status_code == 200
    assert any(item["incident_id"] == created_incident["incident_id"] for item in incident_list.json())


def test_agent_asks_for_missing_environment_and_lists_active_incidents(client):
    test_client, _ = client
    detected = test_client.post("/api/agent/chat", json={"message": "Checkout is broken."}).json()
    assert detected["kind"] == "clarification"
    assert detected["context"]["awaiting"] == "environment"

    clarified = test_client.post("/api/agent/chat", json={
        "message": "production",
        "context": detected["context"],
    }).json()
    assert clarified["kind"] == "detected_incident"
    assert clarified["detected_incident"]["environment"] == "production"

    active = test_client.post("/api/agent/chat", json={"message": "Check active incidents"})
    assert active.status_code == 200
    assert active.json()["kind"] == "incident_list"


def test_active_match_requires_update_or_separate_incident_choice(client):
    test_client, session_factory = client
    db = session_factory()
    db.add(IncidentRecord(
        incident_id="INC-ACTIVE-1",
        title="Payment API latency spike",
        service="payments-api",
        severity="SEV-1",
        status="INVESTIGATING",
        symptoms="Payment API is reporting elevated latency and HTTP 503 responses.",
        error_logs="HTTP 503 errors",
        runbook_used="CHECK_DEPLOYMENT_HEALTH",
        successful=False,
        created_at=datetime.utcnow(),
    ))
    db.commit()
    db.close()

    detected = test_client.post("/api/agent/chat", json={
        "message": "Payment API is down in production. We are getting 503 errors after deployment.",
    }).json()
    investigated = test_client.post("/api/agent/chat", json={
        "message": "Yes, investigate",
        "context": detected["context"],
    }).json()

    assert investigated["context"]["awaiting"] == "active_incident_choice"
    assert investigated["investigation"]["active_incident"]["incident_id"] == "INC-ACTIVE-1"
    assert investigated["create_available"] is False

    update = test_client.post("/api/agent/chat", json={
        "message": "Update existing incident",
        "context": investigated["context"],
    })
    assert update.status_code == 200
    assert update.json()["kind"] == "update_request"
    assert update.json()["incident_id"] == "INC-ACTIVE-1"

    action = test_client.post("/api/incidents/INC-ACTIVE-1/actions", json={
        "action": "add_note",
        "detail": update.json()["detail"],
    })
    assert action.status_code == 200
    events = test_client.get("/api/incidents/INC-ACTIVE-1/events")
    assert events.status_code == 200
    assert events.json()[0]["event_type"] == "add_note"
