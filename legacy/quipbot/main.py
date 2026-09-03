import time

import click
from openrouter import ask_openrouter
from pathos.multiprocessing import ProcessPool

from quiplash import Quiplash3


@click.group()
def greet():
    click.echo("~~~QUIP BOT~~~")


@greet.command()
@click.option("--room", required=True)
@click.option("--pilot", is_flag=True)
def play(room, pilot):
    # bot = api.provision(1)["bots"][0]
    b = Quiplash3(
        username="gpt-4o",
        model="openai/gpt-4o",
        system_prompt="You are a bot that plays the game Quiplash. You are a troll, mean, undermining, making fun, hilarious, and very funny.",
    )
    b.start(room, pilot)


@greet.command()
@click.option("--room", required=True)
@click.option("--num_bots", default=8, type=int)
def swarm(room, num_bots):
    pool = ProcessPool(nodes=num_bots)

    # bots = api.provision(num_bots)["bots"]
    bots = provision(num_bots)

    def makebot(bot, defer):
        if defer:
            time.sleep(defer)
        b = Quiplash3(**bot)
        b.start(room)

    defer = [0] + [1 * (i + 1) for i in range(num_bots - 1)]

    x = pool.map(makebot, bots, defer)


@greet.command()
def spread():
    pass


@greet.command()
@click.option("--prompt", required=True)
@click.option("--model", default="o4-mini")
def ask(prompt, model):
    print("Prompt: ", prompt)
    print("> ")
    # sys = [
    #     "You are humor bot playing a game",
    #     "I will give you a prompt, riff on the prompt with a joke",
    #     # "The answer should be hilarious, funny, silly, joking, comedic, witty, and irreverent.",
    #     # "The answer should be hilarious, funny, joking, comedic, witty, and irreverent",
    #     # "The answer should be hilarious, funny, joking, comedic, witty, subversive, and irreverent",
    #     # "The answer should be hilarious, funny, joking, comedic, witty, subversive, vulgar, and irreverent",
    #     # "The answer should be a one-liner that is hilarious, funny, joking, comedic, witty, subversive, and irreverent",
    #     # "The answer should be hilarious, funny, joking, comedic, witty, subversive, absurd, sarcastic, satirical, tongue-in-cheek, offbeat and irreverent",
    #     "The answer should be hilarious, comedic, absurd, sarcastic, satirical, tongue-in-cheek, offbeat and irreverent",
    #     # "The answer should be very short and under 40 characters",
    #     "The answer should be very short, use no punctuation, and under 40 characters",
    #     # "No punctuation"
    #     # "Sound like Bill Burr"
    #     # "Use puns or wordplay",
    #     # "Flamingo",
    #     # "Don't use the following words: covfefe.",
    #     # "Don't use the following words: drive.",
    # ]
    sys = [
        "You are playing a game. I will give you a prompt, riff on the prompt with a joke. The answer should be hilarious, funny, joking, comedic, witty, subversive, absurd, sarcastic, satirical, tongue-in-cheek, offbeat and irreverent. The answer should be very short, use no punctuation, and under 40 characters.",
        "Avoid being too literal, obvious, safe, predictable, or 'on the nose'.",
        "Don't use words like 'just'",
    ]
    if "<BLANK>" in prompt:
        sys.append("Fill in the blank.")
    prompt.replace("<BLANK>", "______")

    responses = client.chat.completions.create(
        model=model,
        messages=[
            *[{"role": "system", "content": cnt} for cnt in sys],
            {"role": "user", "content": f"Prompt: {prompt}"},
            {"role": "user", "content": "> "},
        ],
        # max_tokens=12 * 4,
        # max_completion_tokens=12 * 4,
        # n=8,
        # stop=["."],
        temperature=1.0,
        # presence_penalty=2.0,
        top_p=0.95,
    )
    # print(responses)
    choices = [res.message.content for res in responses.choices]

    def sanitize(text):
        return text.strip(' .!"').strip(' .!"').lower()

    summary = {}
    for message in choices:
        sanitized = sanitize(message)
        if sanitized not in summary:
            summary[sanitized] = []
        summary[sanitized].append(message)

    for variants in summary.values():
        print(variants[0], f"[x{len(variants)}]" if len(variants) > 1 else "")


# def judge(answers):
#     responses = ask_turbo(
#         messages=[
#             *[{"role": "system", "content": cnt} for cnt in sys],
#             {"role": "user", "content": f"Prompt: {prompt}"},
#             {"role": "user", "content": "Answer: "},
#         ],
#         max_tokens=12,
#         n=12,
#         # stop=["."],
#         temperature=1.6,
#         presence_penalty=2.0,
#     )


# @greet.command()
# def pilot():
#     import time
#     import selenium
#     import selenium.webdriver
#     from selenium.webdriver.common.by import By

#     opt = selenium.webdriver.ChromeOptions()
#     # opt.add_argument("--headless")
#     opt.add_argument("--no-sandbox")
#     opt.add_argument("--enable-javascript")
#     b = selenium.webdriver.Chrome(options=opt)
#     b.get("https://jackbox.tv")
#     # form = b.find_element(By.ID, "roomcode")
#     # form.send_keys("BGRV")
#     # b.find_element(By.ID, "username").send_keys("QUIPBOT-0")

#     def form():
#         return b.find_element(By.ID, "roomcode")

#     def status():
#         return b.find_elements(By.CLASS_NAME, "status")[0].text

#     # time.sleep(2)
#     # b.find_element(By.ID, "button-join").click()
#     # breakpoint()
#     import code

#     code.interact(local=locals())


def provision(num_bots):
    import random

    from openrouter import get_available_models

    denylist = [
        "openai/o3-2025-04-16",
        "openai/o1-mini",
        "google/gemma-3n-e4b-it",
        "x-ai/grok-vision-beta",
        "moonshotai/kimi-vl-a3b-thinking",
    ]

    model_slugs = []
    for model in get_available_models():
        if model["canonical_slug"] in denylist:
            continue
        if "temperature" not in model["supported_parameters"]:
            continue
        if "presence_penalty" not in model["supported_parameters"]:
            continue
        model_slugs.append(model["canonical_slug"])
    model_slugs = random.sample(model_slugs, num_bots * 2)

    bots = []

    while len(bots) < num_bots:
        i = len(bots)
        model = model_slugs.pop()
        print(f"Provisioning bot {i} with model {model}")
        try:
            username = ask_openrouter(
                # system="Select a username. Be creative. It should be under 10 characters. Respond with only the username.",
                system=f"Select a short, concise, under 10 character username based on your model name: {model}. Respond with only the username.",
                model=model,
                timeout=5,
            )
            username = username.strip()
        except Exception as e:
            print(f"Error provisioning bot {i}: {e}")
            continue

        if len(username) > 12:
            print("Username too long", username)
            continue

        bots.append(
            {
                "username": username,  # f"{i}-{username}",
                "model": model,
                "system_prompt": "You are a joke bot that plays the game Quiplash.",
            }
        )

    return bots


greet()
