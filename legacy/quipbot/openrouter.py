from openai import OpenAI
import os
import requests

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),
    default_headers={
        "HTTP-Referer": "https://downlink.dev",
        "X-Title": "QuipArena",
    },
)


def ask_openrouter(system=None, user=None, model="openai/gpt-4o", **kwargs):
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    if user:
        messages.append({"role": "user", "content": user})

    if "temperature" not in kwargs:
        kwargs["temperature"] = 0.7

    completion = client.chat.completions.create(
        model=model,
        messages=messages,
        **kwargs,
    )
    return completion.choices[0].message.content


def get_available_models():
    response = requests.get(
        "https://openrouter.ai/api/v1/models/user",
        headers={"Authorization": f"Bearer {os.getenv('OPENROUTER_API_KEY')}"},
    )
    return response.json()["data"]
