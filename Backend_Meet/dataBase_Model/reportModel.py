from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from database import Base


class Reports(Base):
    __tablename__ = "reports"

    id=Column(Integer,primary_key=True, autoincrement=True)

    report_ss_url=Column(String(200),nullable= True)
    report_by=Column(Integer,nullable= True) 
    report_description=Column(Text,nullable= True) 
    report_for=Column(Integer,nullable=True)
    report_at=Column(DateTime,default= datetime.utcnow(),nullable= False)