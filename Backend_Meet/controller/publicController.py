# publicController.py

from datetime import datetime, timedelta
import enum
import os
import time
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Cookie,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status as http_status,
)
from jose import JWTError, jwt
from sqlalchemy import and_, func, not_, or_
from sqlalchemy.orm import Session, joinedload
import stripe

from dataBase_Model.subscription_db import SubscriptionPlan
from dataBase_Model.user_model import User
from dataBase_Model.video_call import VideoCall
from dataBase_Model.video_call_subscription import Video_Call_Subscription
from enums.call_status import CallStatus
from enums.plan_status import status as PlanStatus
from enums.roleEnum import Role

from database import get_db
from jwts.jwt_config import ALGORITHM, SECRET_KEY, create_access_token, create_refresh_token
from jwts.jwt_response_schemas import Token
from mail.sendmail import send_mail
from otp_generate.otp import generate_otp, get_otp_expiry
from requestmodel.friend_request_request import friend_request_Model
from requestmodel.loginRequest_model import LoginRequest
from requestmodel.optRequest import otp_req
from security.role_authenticated import get_authenticated_active_user, get_websocket_user, require_roles
from schemas.user_schema import UserDirectoryResponse, UserRegister, UserResponse
from util_validate.password_security import hash_password, verify_password
from service.notification_service import create_notification

from dataBase_Model.friend_request import FriendRequest
from dataBase_Model.notifiactionModel import Notification
from enums.Request_Status import re_status

import os
import shutil
import uuid

from google import genai
from google.genai import types
from fastapi import UploadFile, File, BackgroundTasks
from dataBase_Model.document_rag import DocumentChat, DocumentChunk
from service.rag_service import process_document_background
from  otp_generate.randomKey import get_random_letters
from mail.sendmail import send_key
from requestmodel.resetRequest import reset_pass
from util_validate.pasword_name_validate import passwordCheack


client = genai.Client(
    api_key=os.getenv("GEMINI_API_KEY")
)





UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploaded_docs")
os.makedirs(UPLOAD_DIR, exist_ok=True)



BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")
STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")

if not STRIPE_SECRET_KEY:
    raise RuntimeError("STRIPE_SECRET_KEY is not set in environment variables.")
if not STRIPE_WEBHOOK_SECRET:
    raise RuntimeError("STRIPE_WEBHOOK_SECRET is not set in environment variables.")

stripe.api_key = STRIPE_SECRET_KEY

ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 15))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", 7))
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() == "true"


router = APIRouter(prefix="/api/v1/user")


# ===================================================================
# PAYMENT HELPER FUNCTIONS
# ===================================================================
def fulfill_subscription(session: stripe.checkout.Session, db: Session):
    session_dict = session.to_dict() if hasattr(session, "to_dict") else dict(session)
    session_id = session_dict.get("id")
    metadata = session_dict.get("metadata", {})

    user_id = int(metadata.get("user_id"))
    tokens_to_add = int(metadata.get("tokens_to_add", 0))

    # IDEMPOTENCY CHECK: Skip if this checkout session was already fulfilled
    existing_sub = (
        db.query(Video_Call_Subscription)
        .filter(Video_Call_Subscription.stripe_payment_id == session_id)
        .first()
    )

    if existing_sub:
        return  # Already credited by webhook or success URL

    # 1. Update user token wallet
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.token_balance += tokens_to_add

    # 2. Record subscription log
    new_subscription = Video_Call_Subscription(
        user_id=user.id,
        stripe_payment_id=session_id,
        token_amount=tokens_to_add,
        status=PlanStatus.ACTIVE
    )

    create_notification(
        db= db,
        user_id = user_id,
        message= f"pyement done",
        notification_type= "SUCESS PAYMENT",
    )

    db.add(new_subscription)
    db.commit()



def handle_failed_payment(session: stripe.checkout.Session, db: Session):
    session_dict = session.to_dict() if hasattr(session, "to_dict") else dict(session)
    session_id = session_dict.get("id")
    metadata = session_dict.get("metadata", {})
    user_id = metadata.get("user_id")

    if not user_id:
        return

    if db.query(Video_Call_Subscription).filter(
        Video_Call_Subscription.stripe_payment_id == session_id
    ).first():
        return

    failed_sub = Video_Call_Subscription(
        user_id=int(user_id),
        stripe_payment_id=session_id,
        token_amount=0,
        status=PlanStatus.EXPIRED
    )

    create_notification(
            db= db,
            user_id = user_id,
            message= f"pyement Faild",
            notification_type= "FAILD PAYMENT",
        )
    db.add(failed_sub)
    db.commit()


# ===================================================================
# AUTH ROUTES
# ===================================================================
@router.post("/login")
async def login(
    payload: LoginRequest,
    response: Response,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.email == payload.email.strip().lower()).first()
    clear_password = payload.password.strip()

    if not user or not verify_password(clear_password, user.password):
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    if not user.is_verified:
        otp = generate_otp()
        otp_expiry = get_otp_expiry(minutes=10)

        user.otp = otp
        user.otp_expiry = otp_expiry
        db.commit()
        db.refresh(user)

        background_tasks.add_task(send_mail, user.email, otp)
        return {"message": "Account unverified. OTP sent to email."}

    access_token = create_access_token({"sub": user.email})
    refresh_token = create_refresh_token({"sub": user.email})

    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/api/v1/user/refresh",
    )

    role_str = user.role.value if hasattr(user.role, "value") else str(user.role)

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "role": role_str,
        "redirect_url": f"/api/v1/{role_str}/dashboard",
    }


@router.post("/register")
async def register(
    payload: UserRegister,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    clean_email = payload.email.strip().lower()
    existing_user = db.query(User).filter(User.email == clean_email).first()

    if existing_user:
        if existing_user.role == Role.ADMIN:
            raise HTTPException(
                status_code=http_status.HTTP_400_BAD_REQUEST,
                detail="This is not an admin endpoint",
            )
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="User with this email already exists",
        )

    otp = generate_otp()
    otp_expiry = get_otp_expiry(minutes=10)

    new_user = User(
        name=payload.name,
        email=clean_email,
        password=hash_password(payload.password),
        role=Role.USER,
        token_balance=0,
        otp=otp,
        otp_expiry=otp_expiry,
        is_verified=False,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    background_tasks.add_task(send_mail, clean_email, otp)
    return {"message": "Registration successful. OTP sent to your email."}


@router.post("/verify_otp")
async def verify_otp(payload: otp_req, db: Session = Depends(get_db)):
    clean_email = payload.email.strip().lower()
    clean_otp = payload.otp_input.strip().zfill(6)

    user = db.query(User).filter(User.email == clean_email).first()

    if not user:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="User does not exist"
        )

    if user.otp != clean_otp:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Invalid OTP"
        )

    if user.otp_expiry and user.otp_expiry <= datetime.utcnow():
        user.otp = None
        user.otp_expiry = None
        
        db.commit()
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="OTP timed out"
        )

    user.is_verified = True
    user.otp = None
    user.otp_expiry = None
    db.commit()

    return {"message": "Account verified successfully. Please login."}


@router.post("/refresh", response_model=Token)
async def refresh_access_token(
    response: Response,
    refresh_token: Optional[str] = Cookie(None),
    db: Session = Depends(get_db),
):
    cred_exc = HTTPException(
        status_code=http_status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired refresh token",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if not refresh_token:
        raise cred_exc

    try:
        payload = jwt.decode(refresh_token, SECRET_KEY, algorithms=[ALGORITHM])
        user_email: Optional[str] = payload.get("sub")
        token_type: Optional[str] = payload.get("type")

        if user_email is None or token_type != "refresh":
            raise cred_exc
    except JWTError:
        raise cred_exc

    user = db.query(User).filter(User.email == user_email).first()
    if not user:
        raise cred_exc

    new_access_token = create_access_token({"sub": user.email})
    role_str = user.role.value if hasattr(user.role, "value") else str(user.role)

    return {
        "access_token": new_access_token,
        "token_type": "bearer",
        "role": role_str,
        "redirect_url": f"/api/v1/{role_str}/dashboard",
    }


# ===================================================================
# PAYMENT ROUTES
# ===================================================================
@router.post("/activate_plan")
async def pay(
    plan_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER)),
):
    plan = (
        db.query(SubscriptionPlan)
        .filter(SubscriptionPlan.id == plan_id)
        .first()
    )

    if not plan:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Subscription plan not found",
        )

    price_id = plan.stripe_price_id
    if not price_id:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Stripe price ID is missing for this plan",
        )

    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="payment",
            success_url=f"{BASE_URL}/api/v1/user/payment/success?session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{BASE_URL}/api/v1/user/payment/cancel",
            metadata={
                "user_id": str(current_user.id),
                "plan_id": str(plan.id),
                "tokens_to_add": str(plan.token_amount),
            },
        )
    except stripe.StripeError as e:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Stripe error: {str(e)}",
        )

    return {
        "message": "Copy and open the checkout URL to complete payment.",
        "checkout_url": checkout_session.url,
        "plan": {
            "id": plan.id,
            "name": plan.name,
            "tokens_to_receive": plan.token_amount,
            "amount_to_pay": plan.amount_to_pay,
            "currency": plan.currency,
        },
        "user_wallet": {
            "current_balance": current_user.token_balance,
            "balance_after_purchase": current_user.token_balance + plan.token_amount,
        }
    }


@router.get("/payment/success")
async def payment_success(
    session_id: str,
    db: Session = Depends(get_db),
):
    session = stripe.checkout.Session.retrieve(session_id)

    if session.payment_status == "paid":
        # Stripe cannot call a localhost webhook. Fulfill the paid session here
        # as an idempotent fallback; the webhook remains the normal production path.
        fulfill_subscription(session, db)
        return {
            "status": "success",
            "message": "Payment completed. Your wallet and notification were updated.",
        }

    raise HTTPException(status_code=400, detail="Payment incomplete.")


@router.post("/stripe/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Invalid Stripe signature",
        )

    event_type = event["type"]
    session = event["data"]["object"]

    if event_type == "checkout.session.completed":
        fulfill_subscription(session, db)
    elif event_type == "checkout.session.async_payment_failed":
        handle_failed_payment(session, db)

    return {"status": "success"}


@router.post("/send_friend_request")
async def send_friend_request(
    receiver_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):

    if current_user.id == receiver_id:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="You cannot send a friend request to yourself"
        )

   
    exist_user = db.query(User).filter(User.id == receiver_id).first()
    if not exist_user:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, 
            detail="User not found"
        )

   
    existing_request = db.query(FriendRequest).filter(
        FriendRequest.sender_id == current_user.id,
        FriendRequest.receiver_id == receiver_id
    ).first()

    if existing_request:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Friend request already sent or exists"
        )

    new_request = FriendRequest(
        sender_id=current_user.id,
        receiver_id=receiver_id,
        request_status=re_status.SENT,
        send_at=datetime.now()
    )

    db.add(new_request)
    db.commit()

    create_notification(
        db=db,
        user_id=receiver_id,
        message=f"New friend request from: {current_user.name} [sender_id:{current_user.id}]",
        notification_type="FRIEND_REQUEST",
        sender_id=current_user.id,
    )

    return {"message": f"Friend request sent to: {exist_user.name}"}


@router.put("/update_request")
async def friend_request_update(
    payload: friend_request_Model,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    sender_id = payload.sender_id
    req_status = payload.status.lower().strip()

    # Verify sender exists
    sender = db.query(User).filter(User.id == sender_id).first()
    if not sender:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND, 
            detail="User not found"
        )

  
    request_obj = db.query(FriendRequest).filter(
        FriendRequest.sender_id == sender_id,
        FriendRequest.receiver_id == current_user.id
    ).first()

    if not request_obj:
        raise HTTPException(
            status_code=http_status.HTTP_404_NOT_FOUND,
            detail="Pending friend request not found"
        )

    if req_status in ["yes", "accept"]:
        request_obj.request_status = re_status.ACCEPT
        notification_msg = f"{current_user.name} accepted your friend request."
        notification_type = "FRIEND_REQUEST_ACCEPT"
    elif req_status in ["no", "reject"]:
        request_obj.request_status = re_status.REJECT
        notification_msg = f"{current_user.name} rejected your friend request."
        notification_type = "FRIEND_REQUEST_REJECT"
    else:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail="Invalid status value. Use 'yes' or 'no'."
        )

    db.commit()

    create_notification(
        db=db,
        user_id=sender_id,
        message=notification_msg,
        notification_type=notification_type
    )

    return {"message": "Friend request updated successfully"}



@router.get("/all_subscription")
async def get_all_sb( db: Session = Depends(get_db),
    ):
   sub= db.query(SubscriptionPlan).all()

   return sub;


@router.get("/me", response_model=UserResponse)
async def get_current_user_profile(
    current_user: User = Depends(require_roles(Role.USER, Role.ADMIN)),
):
    return current_user


  # Allows Pydantic to read ORM objects directly (formerly `orm_mode = True` in Pydantic v1)



# 2. Add response_model=List[UserResponse] to the decorator
@router.get("/users", response_model=List[UserDirectoryResponse])
def get_all_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    users = (
        db.query(User)
        .filter(User.role == Role.USER, User.id != current_user.id)
        .offset(skip)
        .limit(limit)
        .all()
    )
    return users


@router.post("/documents/upload")
async def upload_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    # Save file locally
    file_id = str(uuid.uuid4())
    original_filename = file.filename or "upload"
    extension = os.path.splitext(original_filename)[1].lower()
    allowed_extensions = {".pdf", ".txt", ".md", ".java", ".py", ".js", ".ts"}
    if extension not in allowed_extensions:
        raise HTTPException(status_code=400, detail="Unsupported document type.")

    file_path = os.path.join(UPLOAD_DIR, f"{file_id}{extension}")
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Store file record in DB
    doc_record = DocumentChat(
        user_id=current_user.id,
        filename=original_filename,
        file_path=file_path
    )
    db.add(doc_record)
    db.commit()
    db.refresh(doc_record)

    # Trigger background parsing, chunking, and embedding creation
    background_tasks.add_task(process_document_background, doc_record.id)

    return {
        "message": "File uploaded successfully. Processing in background.",
        "document_id": doc_record.id
    }


@router.post("/documents/{document_id}/ask")
async def ask_document_question(
    document_id: int,
    question: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles(Role.USER))
):
    document = (
        db.query(DocumentChat)
        .filter(
            DocumentChat.id == document_id,
            DocumentChat.user_id == current_user.id,
        )
        .first()
    )
    if not document:
        raise HTTPException(status_code=404, detail="Document not found.")

    # 1. Create embedding for user's question

    query_embedding_res = client.models.embed_content(
        model="gemini-embedding-001",
        contents=question,
        config=types.EmbedContentConfig(
            task_type="RETRIEVAL_QUERY",
            output_dimensionality=768,
        ),
    )

    query_embedding = (
        query_embedding_res.embeddings[0].values
    )

    # 2. Search relevant chunks

    matched_chunks = (
        db.query(DocumentChunk)
        .filter(
            DocumentChunk.document_id == document.id
        )
        .order_by(
            DocumentChunk.embedding.cosine_distance(
                query_embedding
            )
        )
        .limit(3)
        .all()
    )

    if matched_chunks:
        print(matched_chunks[0].content) 

    if not matched_chunks:
        raise HTTPException(
            status_code=404,
            detail="No relevant document content found."
        )

    # 3. Build context

    context_text = "\n\n".join(
        c.content for c in matched_chunks
    )

    # 4. Ask Gemini

    prompt = f"""
            You are a helpful document assistant.

            Answer the user's question ONLY using the information provided in the context below.

            Keep your answer SHORT, BRIEF, and DIRECT.
            Give only the information necessary to answer the question.
            Do not provide unnecessary explanations, background information, or assumptions.
            Do not use information from outside the context.

            Context:
            {context_text}

            Question:
            {question}

            If the answer is not available in the context, respond exactly:
            "Information is not available in the uploaded document."
            """

    response = client.models.generate_content(
        model="gemini-3.5-flash-lite",
        contents=prompt
    )

    return {
        "question": question,
        "retrieved_context": [
            c.content for c in matched_chunks
        ],
        "answer": response.text
    }




# 
@router.get("/get_all_friend", response_model=None)
async def get_all_friend(
    db: Session = Depends(get_db),
    cur_user = Depends(require_roles(Role.USER))
):
    # Query requests where current user is either the sender or receiver
    accepted_requests = (
        db.query(FriendRequest)
        .options(joinedload(FriendRequest.sender), joinedload(FriendRequest.receiver))
        .filter(
            FriendRequest.request_status == re_status.ACCEPT,
            or_(
                FriendRequest.sender_id == cur_user.id,
                FriendRequest.receiver_id == cur_user.id
            )
        )
        .all()
    )

    getalluser = []
    for request in accepted_requests:
        # Determine which party in the request is the friend
        friend = request.receiver if request.sender_id == cur_user.id else request.sender
        
        getalluser.append({
            "id": friend.id,
            "name": friend.name,
            "email": friend.email
        })

    return getalluser


@router.get("/user_dashboard")
async def public_user_dashboard(
    db: Session = Depends(get_db),
    curr: User = Depends(require_roles(Role.USER))  # Wrapped in Depends()
):
    active_subscription = (
        db.query(Video_Call_Subscription)
        .filter(
            Video_Call_Subscription.user_id == curr.id,
            Video_Call_Subscription.status == PlanStatus.ACTIVE,
        )
        .order_by(Video_Call_Subscription.created_at.desc())
        .first()
    )

    completed_calls = (
        db.query(VideoCall)
        .filter(
            or_(VideoCall.sender_id == curr.id, VideoCall.receiver_id == curr.id),
            VideoCall.status == CallStatus.COMPLETED
        )
        .all()
    )

    # 3. Get All Accepted Friends
    friend_requests = (
        db.query(FriendRequest)
        .options(joinedload(FriendRequest.sender), joinedload(FriendRequest.receiver))
        .filter(
            FriendRequest.request_status == re_status.ACCEPT,
            or_(FriendRequest.sender_id == curr.id, FriendRequest.receiver_id == curr.id)
        )
        .all()
    )

    friends_list = []
    friend_ids = {curr.id}  # Collect IDs to exclude from available user directory

    for req in friend_requests:
        friend = req.receiver if req.sender_id == curr.id else req.sender
        friend_ids.add(friend.id)
        friends_list.append({
            "id": friend.id,
            "name": friend.name,
            "email": friend.email
        })

    # 4. Get All Non-Friend Users (Available to send friend requests)
    available_users = (
        db.query(User)
        .filter(not_(User.id.in_(friend_ids)))
        .all()
    )

    # 5. Return Aggregated Dashboard Data
    return {
        "user_info": {
            "id": curr.id,
            "name": curr.name,
            "email": curr.email,
            "token_balance": curr.token_balance
        },
        "subscription": {
            "status": active_subscription.status if active_subscription else None,
            "token_amount": active_subscription.token_amount if active_subscription else 0,
        },
        "friends": friends_list,
        "available_users": [
            {"id": u.id, "name": u.name, "email": u.email} 
            for u in available_users
        ],
        "completed_calls": [
            {
                "call_id": call.id,
                "room_id": call.room_id,
                "created_at": call.start_time
            } 
            for call in completed_calls
        ]
    }




@router.post("/forgetpass")
async def forgetpass(email: str, backg: BackgroundTasks, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(400, detail="User not exist")

    otp = generate_otp()
    expire = datetime.now() + timedelta(seconds=300)
    user.otp = otp
    user.otp_expiry = expire

    # Fix: Ensure key is extracted as a string if get_random_letters returns a dict
    key_res = get_random_letters()
    key = key_res.get("random_letters") if isinstance(key_res, dict) else key_res

    user.secret_key = key
    db.commit()
    db.refresh(user)
    
    backg.add_task(send_mail, email, otp=otp)
    backg.add_task(send_key, email, key)

    return "otp & key send to your mail for reset password"



@router.post("/reset_pass")
async def reset_pass(payload: reset_pass, db: Session = Depends(get_db)):
    user = db.query(User).filter(payload.email == User.email).first()

    if not user:
        raise HTTPException(400, detail="not found")

    if user.secret_key != payload.key:
        raise HTTPException(400, detail="bad request")

    if passwordCheack(payload.new_pass) == False:
        raise HTTPException(400, detail="password must 6 len long contain atleast one sp char")

    if payload.new_pass != payload.confrim_pass:
        raise HTTPException(400, detail="confirm pass not match")

    hashpass = hash_password(payload.new_pass)
    user.secret_key = None
    user.password = hashpass  # Fixed: assigning the hashed string variable
    db.commit()
    db.refresh(user)

    return "password successfully change"