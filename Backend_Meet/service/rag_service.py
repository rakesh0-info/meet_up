import os

from dotenv import load_dotenv
from google import genai
from google.genai import types
from pypdf import PdfReader
from sqlalchemy.orm import Session
from fastapi import HTTPException

from database import SessionLocal
from dataBase_Model.document_rag import DocumentChat, DocumentChunk


load_dotenv()

client = genai.Client(
    api_key=os.getenv("GEMINI_API_KEY")
)


def extract_text_from_file(file_path: str) -> str:

    text = ""

    if file_path.lower().endswith(".pdf"):

        reader = PdfReader(file_path)

        for page in reader.pages:

            extracted = page.extract_text()

            if extracted:
                text += extracted + "\n"

    else:

        try:
        
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                    text = f.read()  
        except Exception as e:
            print(f"An error occurred during the file read: {e}")
            raise HTTPException(status_code=400, detail="Something went wrong")

    return text


def chunk_text(
    text: str,
    chunk_size: int = 500,
    overlap: int = 50
) -> list[str]:

    words = text.split()

    chunks = []

    for i in range(
        0,
        len(words),
        chunk_size - overlap
    ):

        chunk = " ".join(
            words[i:i + chunk_size]
        )

        if chunk:
            chunks.append(chunk)

    return chunks


def process_document_background(doc_id: int):

    db: Session = SessionLocal()

    try:

        doc = (
            db.query(DocumentChat)
            .filter(DocumentChat.id == doc_id)
            .first()
        )

        if not doc:
            return

        # --------------------------------
        # 1. Extract text
        # --------------------------------

        raw_text = extract_text_from_file(
            doc.file_path
        )

        doc.extracted_text = raw_text

        # --------------------------------
        # 2. Create chunks
        # --------------------------------

        chunks = chunk_text(raw_text)

        # --------------------------------
        # 3. Generate embeddings
        # --------------------------------

        for index, chunk in enumerate(chunks):

            embedding_res = client.models.embed_content(
                model="gemini-embedding-001",
                contents=chunk,
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_DOCUMENT",
                    output_dimensionality=768,
                ),
            )

            embedding_vector = (
                embedding_res.embeddings[0].values
            )

            # --------------------------------
            # 4. Save chunk + embedding
            # --------------------------------

            chunk_obj = DocumentChunk(
                document_id=doc.id,
                chunk_index=index,
                content=chunk,
                embedding=embedding_vector
            )

            db.add(chunk_obj)

        db.commit()

        print(
            f"Document {doc_id} processed successfully. "
            f"{len(chunks)} chunks created."
        )

    except Exception as e:

        db.rollback()

        print(
            f"Error processing document {doc_id}: {e}"
        )

        raise

    finally:

        db.close()