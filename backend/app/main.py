from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.agent import router as agent_router
from app.api.incidents import router as incidents_router
from app.api.investigation import router as investigation_router
from app.api.memory import router as memory_router
from app.api.postmortem import router as postmortem_router
from app.api.recommendations import router as recommendations_router
from app.database.database import Base, engine

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Incident Response Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "incident-response-agent"}


app.include_router(incidents_router)
app.include_router(investigation_router)
app.include_router(memory_router)
app.include_router(recommendations_router)
app.include_router(postmortem_router)
app.include_router(agent_router)
