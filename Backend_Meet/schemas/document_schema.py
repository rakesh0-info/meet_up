# schemas/document_schema.py
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class DocumentUploadResponse(BaseModel):
    id: int
    user_id: int
    filename: str
    file_path: str
    summary: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True

class DocumentQueryRequest(BaseModel):
    document_id: int
    question: str

class DocumentQueryResponse(BaseModel):
    document_id: int
    question: str
    answer: str