import os

from dotenv import load_dotenv
from google import genai
from google.genai import types
from pypdf import PdfReader
import pypdf
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
        doc = db.query(DocumentChat).filter(DocumentChat.id == doc_id).first()
        if not doc:
            return

        doc.status = "PROCESSING"
        db.commit()

        # --------------------------------
        # 1. Extract text based on file type
        # --------------------------------
        all_chunks_with_metadata = []
        global_chunk_index = 0

        if doc.file_path.lower().endswith(".pdf"):
            reader = pypdf.PdfReader(doc.file_path)
            full_raw_text = ""
            for page_num, page in enumerate(reader.pages, start=1):
                page_text = page.extract_text() or ""
                full_raw_text += f"\n--- Page {page_num} ---\n" + page_text
                
                page_chunks = chunk_text(page_text)
                for chunk_text_item in page_chunks:
                    formatted_content = f"[Page {page_num}]\n{chunk_text_item}"
                    all_chunks_with_metadata.append({
                        "content": formatted_content,
                        "page_number": page_num,
                        "chunk_index": global_chunk_index
                    })
                    global_chunk_index += 1
            doc.extracted_text = full_raw_text
        else:
            # Handle .txt, .java, .py, etc.
            with open(doc.file_path, "r", encoding="utf-8", errors="replace") as f:
                full_raw_text = f.read()
            
            doc.extracted_text = full_raw_text
            file_chunks = chunk_text(full_raw_text)
            for chunk_text_item in file_chunks:
                all_chunks_with_metadata.append({
                    "content": chunk_text_item,
                    "page_number": 1,  # Default page for text files
                    "chunk_index": global_chunk_index
                })
                global_chunk_index += 1

        db.commit()

        if not all_chunks_with_metadata:
            doc.status = "COMPLETED"
            db.commit()
            return

        # --------------------------------
        # 2. Generate embeddings in batches (remains the same)
        # --------------------------------
        BATCH_SIZE = 25 
        
        for i in range(0, len(all_chunks_with_metadata), BATCH_SIZE):
            batch_items = all_chunks_with_metadata[i : i + BATCH_SIZE]
            batch_contents = [[item["content"]] for item in batch_items]
            
            embedding_res = client.models.embed_content(
                model="gemini-embedding-001",
                contents=batch_contents,
                config=types.EmbedContentConfig(
                    task_type="RETRIEVAL_DOCUMENT",
                    output_dimensionality=768,
                ),
            )

            for item, emb in zip(batch_items, embedding_res.embeddings):
                chunk_obj = DocumentChunk(
                    document_id=doc.id,
                    chunk_index=item["chunk_index"],
                    content=item["content"],
                    page_number=item["page_number"],
                    embedding=emb.values
                )
                db.add(chunk_obj)

            db.commit()

        doc.status = "COMPLETED"
        db.commit()
        print(f"Document {doc_id} processed successfully. {len(all_chunks_with_metadata)} chunks created.")

    except Exception as e:
        db.rollback()
        print(f"Error processing document {doc_id}: {e}")
        try:
            failed_doc = db.query(DocumentChat).filter(DocumentChat.id == doc_id).first()
            if failed_doc:
                failed_doc.status = "FAILED"
                failed_doc.error_message = str(e)
                db.commit()
        except Exception as db_err:
            print(f"Failed to record error state for document {doc_id}: {db_err}")

    finally:
        db.close()