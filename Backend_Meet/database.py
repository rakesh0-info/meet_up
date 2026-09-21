import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is not set.")

engine_options = {}
if DATABASE_URL.startswith(("postgresql://", "postgresql+")):
    engine_options["connect_args"] = {"options": '-csearch_path="Meet_up"'}

engine = create_engine(DATABASE_URL, **engine_options)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

if DATABASE_URL.startswith(("postgresql://", "postgresql+")):
    with engine.connect() as connection:
        connection.execute(text('CREATE SCHEMA IF NOT EXISTS "Meet_up"'))
        connection.commit()

Base = declarative_base()
Base.metadata.schema = "Meet_up"


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()