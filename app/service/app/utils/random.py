import random
import string


def generate_ramdom(length: int) -> str:
    """generate 24-digit random string, include uppercase and lowercase letters and numbers"""
    characters = string.ascii_letters + string.digits
    return ''.join(random.choice(characters) for _ in range(length))
