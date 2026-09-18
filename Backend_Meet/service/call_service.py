import os
from datetime import datetime
from sqlalchemy.orm import Session
from google import genai

from dataBase_Model.video_call import VideoCall
from enums.call_status import CallStatus

gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


async def finalize_call_and_summarize(room_id: str, transcript_lines: list, db: Session):
    call_record = db.query(VideoCall).filter(VideoCall.room_id == room_id).first()
    if not call_record:
        return

    full_transcript = "\n".join(transcript_lines) if transcript_lines else "No audio transcript recorded."
    call_record.translation = full_transcript
    call_record.end_time = datetime.utcnow()

    # Generate Summary via Gemini
    if transcript_lines:
        prompt = f"""
        You are an AI meeting assistant. Summarize the following video call conversation in detail.
        
        Provide:
        1. Key Discussion Points
        2. Action Items & Decisions
        3. Brief Conclusion

        Transcript:
        {full_transcript}
        """
        try:
            response = gemini_client.models.generate_content(
                model="gemini-3.5-flash-lite",
                contents=prompt
            )
            call_record.summary = response.text
        except Exception as e:
            call_record.summary = f"Failed to generate AI summary: {str(e)}"
    else:
        call_record.summary = "No speech detected during the call."

    if call_record.status == CallStatus.ACTIVE:
        call_record.status = CallStatus.COMPLETED

    db.commit()
    db.refresh(call_record)
    return call_record