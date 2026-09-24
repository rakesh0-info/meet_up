import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
from dotenv import load_dotenv
from fastapi import Depends



load_dotenv()

SMTP_SERVER = os.getenv("SMTP_SERVER", "smtp.gmail.com").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", 465))            
SENDER_EMAIL = os.getenv("SENDER_EMAIL")
SENDER_PASSWORD = os.getenv("SMTP_PASSWORD")  

async def send_mail(receiver_mail: str, otp: str):
    msg = MIMEMultipart()
    msg["From"] = SENDER_EMAIL
    msg["To"] = receiver_mail
    msg["Subject"] = "Your Verification OTP"
    
    body_content = f"This is your OTP: {otp}. It will expire in 5 minutes."
    msg.attach(MIMEText(body_content, "plain"))

    try:
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT) as server:
            await server.login(SENDER_EMAIL, SENDER_PASSWORD)
            await server.send_message(msg)
    except Exception as e:
        print("Error sending mail: ", e)


async def send_key(receiver_mail: str, k: str):
    msg = MIMEMultipart()
    msg["From"] = SENDER_EMAIL
    msg["To"] = receiver_mail
    msg["Subject"] = "Your Verification OTP"
    
    body_content = f"This is your key : {k}. use it when u reset password ."
    msg.attach(MIMEText(body_content, "plain"))

    try:
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT) as server:
            await server.login(SENDER_EMAIL, SENDER_PASSWORD)
            await server.send_message(msg)
    except Exception as e:
        print("Error sending mail: ", e)



