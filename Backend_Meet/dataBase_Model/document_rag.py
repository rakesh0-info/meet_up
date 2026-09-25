# dataBase_Model/document_rag.py
from datetime import datetime
from enum import Enum
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey,Enum
from sqlalchemy.orm import relationship
from pgvector.sqlalchemy import Vector
from database import Base
from enums.upload_status import up_status

from dataBase_Model.user_model import User

class DocumentChat(Base):
    __tablename__ = "document_chats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    filename = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    extracted_text = Column(Text, nullable=True)
    summary = Column(Text, nullable=True)
    upload_status=Column(
        Enum(up_status, name="up_status", schema="Meet_up", inherit_schema=True),
        default=up_status.NOT_PROCESS,
        nullable=False
    )
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="document_chats")
    chunks = relationship("DocumentChunk", back_populates="document", cascade="all, delete-orphan")


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(Integer, ForeignKey("document_chats.id", ondelete="CASCADE"), nullable=False)
    chunk_index = Column(Integer, nullable=False)
    page_number = Column(Integer, nullable=True)
    content = Column(Text, nullable=False)
    embedding = Column(Vector(768), nullable=True)  # text-embedding-004 output dimension
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    document = relationship("DocumentChat", back_populates="chunks")


class DocumentMessage(Base):  
    __tablename__ = "document_messages"  

    id = Column(Integer, primary_key=True, autoincrement=True)
    document_id = Column(Integer, ForeignKey("document_chats.id", ondelete="CASCADE"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)  # Fixed typo: CASECADE -> CASCADE
    ask_question = Column(Text, nullable=False)
    ai_ans = Column(Text, nullable=False)
    ask_at = Column(DateTime, default=datetime.utcnow, nullable=False)

   
    document = relationship("DocumentChat", backref="messages")
    user = relationship("User", backref="document_messages")