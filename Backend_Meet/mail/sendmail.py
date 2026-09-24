import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
import asyncio
from dotenv import load_dotenv

load_dotenv()

SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", 465))            
SENDER_EMAIL = os.getenv("SENDER_EMAIL")
SENDER_PASSWORD = os.getenv("SMTP_PASSWORD")  

def _send_mail_sync(receiver_mail: str, subject: str, body: str):
    """Synchronous helper to block safely in a worker thread."""
    msg = MIMEMultipart()
    msg["From"] = SENDER_EMAIL
    msg["To"] = receiver_mail
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    try:
        print(f"DEBUG: Connecting to SMTP server for {receiver_mail}...")
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT) as server:
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.send_message(msg)
        print(f"DEBUG: Email successfully sent to {receiver_mail}!")
    except Exception as e:
        print("Error sending mail traceback:", e)
        raise e

async def send_mail(receiver_mail: str, otp: str):
    body_content = f"This is your OTP: {otp}. It will expire in 5 minutes."
  
    await asyncio.to_thread(_send_mail_sync, receiver_mail, "Your Verification OTP", body_content)


async def send_key(receiver_mail: str, k: str):
    body_content = f"This is your key : {k}. use it when u reset password ."
    await asyncio.to_thread(_send_mail_sync, receiver_mail, "Your Verification key ", body_content)