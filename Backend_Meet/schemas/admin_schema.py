# schemas/admin_schema.py
from pydantic import BaseModel
from typing import List

class UserUsageAdminView(BaseModel):
    user_id: int
    name: str
    email: str
    token_balance: int
    total_calls_made: int
    total_call_duration_seconds: int
    total_tokens_spent: int

class AdminDashboardStats(BaseModel):
    total_users: int
    active_subscriptions: int
    total_calls_conducted: int
    total_tokens_consumed: int
    users_usage_summary: List[UserUsageAdminView]