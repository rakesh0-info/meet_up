import random
import string


def get_random_letters():
    # Combine lowercase and uppercase letters
    letters = string.ascii_letters
    # Pick 10 random letters and join them into a string
    random_10 = "".join(random.choices(letters, k=10))
    return {"random_letters": random_10}