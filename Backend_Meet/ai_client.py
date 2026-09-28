import os
from google import genai
from pinecone import Pinecone

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
pinecone_index_name = os.getenv("PINECONE_INDEX_NAME", "document-chunks")

pinecone_index = pc.Index(pinecone_index_name)