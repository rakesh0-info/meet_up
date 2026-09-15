import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

DATABASE_URL = os.getenv("DATABSE_URL")

engine = create_engine(
    DATABASE_URL,
    connect_args={
        "options": '-csearch_path="Meet_up"'
    }
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

with engine.connect() as connection:
    connection.execute(
        text('CREATE SCHEMA IF NOT EXISTS "Meet_up"')
    )
    connection.commit()

Base = declarative_base()
Base.metadata.schema = "Meet_up"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()