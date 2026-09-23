import os
import time
import pypdf
from dotenv import load_dotenv
from google import genai
from google.genai import types
from sqlalchemy.orm import Session
from fastapi import HTTPException
from enums.upload_status import up_status

from database import SessionLocal
from dataBase_Model.document_rag import DocumentChat, DocumentChunk
from service.notification_service import create_notification

load_dotenv()

# Initialize the official Google GenAI client
client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

def extract_text_from_file(file_path: str) -> str:
    text = ""
    if file_path.lower().endswith(".pdf"):
        reader = pypdf.PdfReader(file_path)
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

def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    words = text.split()
    chunks = []
    for i in range(0, len(words), chunk_size - overlap):
        chunk = " ".join(words[i:i + chunk_size])
        if chunk:
            chunks.append(chunk)
    return chunks

def process_document_background(doc_id: int):
    db: Session = SessionLocal()
    
    try:
        doc = db.query(DocumentChat).filter(DocumentChat.id == doc_id).first()
        if not doc:
            return

        doc.upload_status = up_status.NOT_PROCESS
        db.commit()

        all_chunks_with_metadata = []
        global_chunk_index = 0

        # 1. Extract text based on file type
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
            with open(doc.file_path, "r", encoding="utf-8", errors="replace") as f:
                full_raw_text = f.read()
            
            doc.extracted_text = full_raw_text
            file_chunks = chunk_text(full_raw_text)
            for chunk_text_item in file_chunks:
                all_chunks_with_metadata.append({
                    "content": chunk_text_item,
                    "page_number": 1, 
                    "chunk_index": global_chunk_index
                })
                global_chunk_index += 1

        db.commit()

        if not all_chunks_with_metadata:
            doc.upload_status = up_status.SUCESSFULL
            db.commit()
            return

        # 2. Generate embeddings in batches with rate-limit handling & retries
        BATCH_SIZE = 10  # Balanced size for performance and free-tier limits
        
        for i in range(0, len(all_chunks_with_metadata), BATCH_SIZE):
            batch_items = all_chunks_with_metadata[i : i + BATCH_SIZE]
            batch_contents = [item["content"] for item in batch_items]
            
            max_retries = 3
            retry_delay = 2
            embedding_res = None

            # Retry loop for 429 quota exhaustion errors
            for attempt in range(max_retries):
                try:
                    embedding_res = client.models.embed_content(
                        model="gemini-embedding-001",
                        contents=batch_contents,
                        config=types.EmbedContentConfig(
                            task_type="RETRIEVAL_DOCUMENT",
                            output_dimensionality=768,
                        ),
                    )
                    break
                except Exception as api_err:
                    if "429" in str(api_err) or "RESOURCE_EXHAUSTED" in str(api_err):
                        if attempt < max_retries - 1:
                            print(f"Rate limit hit (429). Retrying in {retry_delay}s... (Attempt {attempt + 1}/{max_retries})")
                            time.sleep(retry_delay)
                            retry_delay *= 2
                        else:
                            raise api_err
                    else:
                        raise api_err

            # Save chunks and their vector embeddings to database
            for item, emb in zip(batch_items, embedding_res.embeddings):
                chunk_obj = DocumentChunk(
                    document_id=doc.id,
                    chunk_index=item["chunk_index"],
                    content=item["content"],
                    page_number=item["page_number"],
                    embedding=emb.values  # List of 768 floats for pgvector
                )
                db.add(chunk_obj)

            # Brief pause between batches to protect against rate limits
            time.sleep(5)

        # 3. Finalize success state
        doc.upload_status=up_status.SUCESSFULL
        db.commit()
        
        create_notification(
            db=db,
            user_id=doc.user_id,
            message="document upload sucessfully",
            notification_type="SYSTEM_NOTIFICATION_DOCUMENT UPLOAD SUCESSFULLY"
        )
        print(f"Document {doc_id} processed successfully. {len(all_chunks_with_metadata)} chunks created.")

    except Exception as e:
        db.rollback()
        print(f"Error processing document {doc_id}: {e}")

        create_notification(
                    db=db,
                    user_id=doc.user_id,
                    message="document upload Fail",
                    notification_type="SYSTEM_NOTIFICATION_DOCUMENT UPLOAD Faild"
                )
        try:
            db.expire_all()
            failed_doc = db.query(DocumentChat).filter(DocumentChat.id == doc_id).first()
            if failed_doc:
                failed_doc.upload_status = up_status.FAILED
                
                
                db.commit()
        except Exception as db_err:
            print(f"Failed to record error state for document {doc_id}: {db_err}")

    finally:
        db.close()



# 