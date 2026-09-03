import json
import random
import time

from selenium.webdriver.common.by import By

# from .chat import ask_chatgpt, ask_gpt_4, gpt_user_chat_message
from openrouter import ask_openrouter
from jackbox import Jackbox, State, Sleeping

GPT_4_PROMPT = (
    "You are playing a game. "
    "I will give you a prompt, riff on the prompt with a joke. The answer should be hilarious, funny, joking, "
    "comedic, witty, subversive, absurd, sarcastic, satirical, tongue-in-cheek, offbeat and irreverent. The "
    "answer should be very short, use no punctuation, and be under 40 characters. "
)


class CheckingForVIP(State):
    NAME = "CheckingForVIP"

    def next(self, bot, context):
        if bot.is_vip():
            bot.vip = True
            return WaitingForOtherPlayers()
        else:
            return Chilling()


class PickingCharacter(State):
    NAME = "PickingCharacter"

    def next(self, bot, context):
        time.sleep(1)
        choice = random.choice(bot.character_options)
        choice.click()
        return CheckingForVIP()


class WaitingForOtherPlayers(Sleeping):
    NAME = "WaitingForOtherPlayers"

    def duration(self):
        return 15

    def on_wake(self, bot, context):
        if bot.start_button:
            return StartingGame()
        else:
            self.nap(3)


class WaitingForGameStart(Sleeping):
    NAME = "WaitingForGameStart"

    def duration(self):
        return 30

    def on_wake(self, bot, context):
        return LookingForWork()


class StartingGame(State):
    NAME = "StartingGame"

    def next(self, bot, context):
        bot.start_button.click()
        return Chilling()


class StartingNewGame(State):
    NAME = "StartingNewGame"

    def next(self, bot, context):
        bot.continue_button.click()
        return Chilling()


class LookingForWork(State):
    NAME = "LookingForWork"

    def next(self, bot, context):
        if bot.prompt_is_active:
            return AnsweringQuestion()
        elif bot.final_prompt_is_active:
            return AnsweringFinalPrompt()
        elif bot.voting_is_active:
            return Voting()
        elif bot.vip and bot.can_continue:
            return StartingNewGame()


class Chilling(Sleeping):
    NAME = "Chilling"

    def duration(self):
        return random.randint(1, 5)

    def on_wake(self, bot, context):
        return LookingForWork()


class AnsweringQuestion(Sleeping):
    NAME = "AnsweringQuestion"

    def duration(self):
        return random.randint(1, 5)

    def on_wake(self, bot, context):
        answer = bot.generate_answer(bot.question_text)
        bot.answer_field.send_keys(answer)
        bot.submit_answer_button.click()
        return Chilling()


class AnsweringFinalPrompt(Sleeping):
    NAME = "AnsweringFinalPrompt"

    def duration(self):
        return random.randint(1, 5)

    def on_wake(self, bot, context):
        a, b, c = bot.generate_final_answers(bot.question_text)
        bot.answer_fields[0].send_keys(a)
        bot.answer_fields[1].send_keys(b)
        bot.answer_fields[2].send_keys(c)
        bot.submit_answer_button.click()
        return Chilling()


class Voting(Sleeping):
    NAME = "Voting"

    def duration(self):
        return random.randint(1, 5)

    def on_wake(self, bot, context):
        options = bot.vote_buttons
        if len(options) == 0:
            print("cant vote")
            return Chilling()
        responses = ""
        for i, opt in enumerate(options):
            responses += f"{'AB'[i]}: {opt.text}\n"

        result = ask_openrouter(
            system="Pick the response that is the funniest, select only one, say only A or B",
            user=responses,
            model=bot.model,
        )

        result = result.strip(". ").lower()[0]

        if result == "a":
            options[0].click()
        elif result == "b":
            options[1].click()
        else:
            print("invalid response", result)
            random.choice(options).click()

        return Chilling()


class Quiplash3(Jackbox):
    def __init__(self, username, model, system_prompt):
        super().__init__(username, model, system_prompt)
        self.game_state = PickingCharacter()
        self.vip = False

    def generate_answer(self, prompt):
        prompt_type = "Riff on the prompt with a joke. "
        if "_______" in prompt:
            prompt_type = "Fill in the blank. "

        result = ask_openrouter(
            system="You are a bot that plays the game Quiplash. You will be given a prompt. Your goal is to be as funny as possible. "
            + prompt_type
            # + f"Your answer should be {self.system_prompt}. "
            + "The answer should be very short, less than 40 characters. "
            + "Only output the answer, no other text.",
            user=prompt,
            model=self.model,
            temperature=1.2,
            presence_penalty=2.0,
        )

        if result.startswith("You are a bot"):
            raise Exception(f"Invalid response with model {self.model}: {result}")

        # Strip emoji and non-unicode characters from the result
        import re

        def remove_emoji_and_non_unicode(text):
            # Remove emoji and non-BMP unicode characters
            # Emoji and most non-standard symbols are outside the BMP (U+10000 and above)
            return re.sub(r"[\U00010000-\U0010FFFF]", "", text)

        result = remove_emoji_and_non_unicode(result)

        print("~" * 80)
        print(f"Model: [{self.model}]")
        print(f"Prompt Type: [{prompt_type}]")
        print(f"Question: [{prompt}]")
        print(f"Answer: [{result}]")

        return result

    def generate_final_answers(self, prompt):
        prompt_type = "Give 3 distinct answers, separated by commas. "

        result = ask_openrouter(
            "You are a bot that plays the game Quiplash. "
            + prompt_type
            + f"Your answer should be {self.system_prompt}. "
            "The answer should be short.",
            user=f"Prompt: {prompt}\n\n" + "Answer:",
            model=self.model,
        )

        print("~" * 80)
        print(f"Model: [{self.model}]")
        print(f"Prompt Type: [{prompt_type}]")
        print(f"Question: [{prompt}]")
        print(f"Answer: [{result}]")

        # if result[-1] == ".":
        #     result = result[0:-2]
        result = result.replace(".", "")

        answers = [res.strip() for res in result.split(",")][0:3]

        if len(answers) < 3:
            answers = answers + [""] * (3 - len(answers))

        return answers

    # def generate_answer(self, quiplash_prompt):
    #     print("~" * 80)
    #     print(f"Question: [{quiplash_prompt}]")

    #     fitb = ""
    #     if "_______" in quiplash_prompt:
    #         fitb = " Fill in the blank."
    #     init = gpt_user_chat_message(
    #         GPT_4_PROMPT + "Provide 3 answers as strings in a JSON array." + fitb
    #     )

    #     prompt = gpt_user_chat_message(f"Prompt: {quiplash_prompt}")
    #     request = gpt_user_chat_message("> ")

    #     (answers_json,) = ask_gpt_4(
    #         max_tokens=12 * 4,
    #         n=1,
    #         temperature=1.2,
    #         presence_penalty=2.0,
    #         messages=[init, prompt, request],
    #     )

    #     answers = json.loads(answers_json)
    #     result = random.choice(answers)

    #     print(f"Answers: [{', '.join(answers)}]")

    #     return result

    # def generate_final_answers(self, quiplash_prompt):
    #     print("~" * 80)
    #     print(f"Question: [{quiplash_prompt}]")
    #     init = GPT_4_PROMPT + "Provide answers as strings in a JSON array."

    #     prompt = f"Prompt: {quiplash_prompt}"
    #     request = "> "

    #     (answers_json,) = ask_openrouter(
    #     )

    #     answers = json.loads(answers_json)

    #     print(f"Answers: [{', '.join(answers)}]")

    #     return answers[0:3]

    @property
    def start_button(self):
        # return self.get_by_id("quiplash-startgame")
        # button = self.browser.find_elements(By.CSS_SELECTOR, ".vipStart button")[0]
        # if button.text.lower() == "start game":
        #     return button
        choices = self.browser.find_elements(By.CSS_SELECTOR, ".vipMenu .choices button")
        if choices and choices[0].text.lower() == "everybody’s in":
            return choices[0]

    def is_vip(self):
        vip_choices = self.browser.find_elements(By.CSS_SELECTOR, ".vipMenu .choices button")
        return len(vip_choices) > 0

    @property
    def can_continue(self):
        title = self.browser.find_elements(By.CSS_SELECTOR, "#vipMenu #title .text")
        if title and title[0].text.lower() == "what do you want to do?":
            return True
        # document.querySelectorAll("#vipMenu #title .text")[0]

    @property
    def continue_button(self):
        buttons = self.browser.find_elements(By.CSS_SELECTOR, ".button")
        if buttons and buttons[0].text.strip().lower() == "same players":
            return buttons[0]

    def game_timeout(self):
        self.game_state = Chilling()

    @property
    def question_text(self):
        question = self.browser.find_elements(By.CSS_SELECTOR, "#prompt .text *")
        if question:
            text = question[1].text.strip()
            if text.lower() not in ["vote for your favorite"]:
                return text

    @property
    def prompt_header(self):
        elements = self.browser.find_elements(By.CSS_SELECTOR, "#prompt .header")
        if elements:
            return elements[0].text.strip()

    @property
    def prompt_is_active(self):
        header = self.prompt_header
        if header:
            return header.lower() in ["prompt 1 of 2", "prompt 2 of 2"]
        return False

    @property
    def final_prompt_is_active(self):
        header = self.prompt_header
        if header:
            return header.lower() in ["final prompt"]
        return False

    @property
    def voting_is_active(self):
        # .doneText
        #  You’re done. Please wait for the other players.
        done_text = self.browser.find_elements(By.CSS_SELECTOR, ".doneText")
        if (
            done_text
            and done_text[0].text.lower() == "you’re done. please wait for the other players."
        ):
            return False
        elements = self.browser.find_elements(By.CSS_SELECTOR, "#prompt .text")
        if elements:
            text = "".join([node.text.lower() for node in elements])
            return "vote for your favorite" in text
        return False

    @property
    def answer_fields(self):
        return self.browser.find_elements(By.CSS_SELECTOR, "#input-text-textarea")

    @property
    def answer_field(self):
        return self.answer_fields[0]

    @property
    def submit_answer_button(self):
        return self.get_by_class("button")[0]

    @property
    def vote_buttons(self):
        return self.get_by_class("button")

    @property
    def character_options(self):
        return self.browser.find_elements(By.CSS_SELECTOR, ".characters:not(.disabled)")
