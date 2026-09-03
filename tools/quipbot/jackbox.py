# from __future__ import annotations

# """
#     TODO: refactor self.browser -> self._browser
# """

import code
import signal
import time
import traceback


import selenium
import selenium.common.exceptions

from selenium.webdriver import Chrome

from selenium.webdriver.common.by import By
# from selenium.webdriver.support.wait import WebDriverWait

# import quipbot.api as api

TICK_RATE = 1


class State:
    NAME = "State"

    def __str__(self):
        return self.NAME

    def enter(self, bot, context):
        pass

    def next(self, bot, context) -> "State":
        raise NotImplementedError


class TerminalState(State):
    def next(self, bot, context):
        pass


class Sleeping(State):
    NAME = "Sleeping"

    def __init__(self):
        self.time_left = self.duration()

    def next(self, bot, context):
        self.time_left -= context["td"]
        if self.time_left <= 0:
            return self.on_wake(bot, context)

    def nap(self, duration):
        self.time_left = duration

    def on_wake(self, bot, context):
        raise NotImplementedError


class Started(State):
    NAME = "Started"

    def next(self, bot, context):
        bot.load()
        return WaitingToLogIn()


class WaitingToLogIn(State):
    NAME = "WaitingToLogIn"

    def next(self, bot, context):
        if bot.roomcode_field:
            return AddingCredentials()


class AddingCredentials(State):
    NAME = "AddingCredentials"

    def next(self, bot, context):
        bot.browser.execute_script(f'document.title = "{bot.username}"')
        # username first, that way the game type is triggered last
        bot.username_field.send_keys(bot.username)
        bot.roomcode_field.send_keys(bot.room)
        return CheckingRoomStatus()


class CheckingRoomStatus(State):
    NAME = "CheckingRoomStatus"

    def next(self, bot, context):
        if bot.status_text == context["game_type"]:
            return LoggingIn()
        elif bot.status_text == RoomStatus.ROOM_NOT_FOUND:
            return LeavingConfused()
        elif bot.status_text == RoomStatus.GAME_IS_FULL:
            return LeavingRejected()


class LoggingIn(State):
    NAME = "LoggingIn"

    def next(self, bot, data):
        bot.join_button.click()
        return WaitingForLogInComplete()


class WaitingForLogInComplete(State):
    NAME = "WaitingForLogInComplete"

    def next(self, bot, context):
        if bot.uuid:
            bot.active()
            return PlayingGame()
        else:
            bot.capture_uuid()


# class Lollygagging(Sleeping):
#     NAME = "Lollygagging"

#     def duration(self):
#         random.randint(0, 5)

#     def on_wake(self, bot, context):
#         return PlayingGame()


class Closing(State):
    NAME = "Closing"

    def next(self, bot, context):
        bot.close()
        return Releasing()


class Releasing(State):
    NAME = "Releasing"

    def next(self, bot, context):
        bot.release()
        return Done()


class Done(TerminalState):
    NAME = "Done"


class Leaving(State):
    NAME = "Leaving"

    def next(self, bot, context):
        return Closing()


class Disconnecting(Leaving):
    NAME = "Disconnecting"


class LeavingConfused(Leaving):
    NAME = "LeavingConfused"


class LeavingRejected(Leaving):
    NAME = "LeavingRejected"


class ForceQuitting(State):
    """
    Not a Leaving state because SIGINT propogates to Selenium and closes
    the browser automatically.
    """

    NAME = "ForceQuitting"

    def next(self, bot, context):
        return Releasing()


class PlayingGame(State):
    NAME = "PlayingGame"

    def next(self, bot, context):
        if bot.modal_text == ModalTexts.DISCONNECTED:
            return Disconnecting()
        bot.play(context)


class Timeout(Sleeping):
    NAME = "Timeout"

    def duration(self):
        return 10

    def on_wake(self, bot, context):
        return PlayingGame()


class RoomStatus:
    QUIPLASH2 = "quiplash 2"
    QUIPLASH3 = "quiplash 3"
    GAME_IS_FULL = "game is full"
    ROOM_NOT_FOUND = "room not found"


class ModalTexts:
    DISCONNECTED = "disconnected"


class Jackbox:
    PERSONALITIES = [
        "spicy, naughty, dirty, funny, and use innuendo",
        "hilarious, silly, witty, and irreverent",
        "a creative poet and always rhyme",
        "stuffy, boring, lame, idiotic, dumb, and misspell words",
        "funny, hilarious, witty, and use puns",
        "shocking, hilarious, outrageous, and unhinged",
        "random, goofy, unpredicatble, offbeat, and silly",
        "artistic, imaginative, innovative, original, and nonconformist",
        "bold, spontaneous, shocking, impulsive, risk-taking, and thrill-seeking",
        "drunk, slurred, and make alcohol references",
        # "sad, dejected, heartbroken, and mention QUIPBOT-55",
        "sad, dejected, heartbroken, and bitter",
        "daredevil, thrill-seeking, references exciting activities",
        "an old person, elderly, grandma, loves knitting and cats",
        "hungry, starving, obese, always thinking about food",
        "troll, mean, undermining, making fun, hilarious",
        "very funny",
        # "Creative: Artistic, imaginative, innovative, original, expressive, open-minded, nonconformist, inventive",
        # "Analytical: Logical, systematic, methodical, detail-oriented, precise, objective, data-driven, critical",
        # "Adventurous: Bold, daring, curious, exploratory, risk-taking, thrill-seeking, spontaneous, impulsive",
        # "Extroverted: Outgoing, sociable, expressive, talkative, energetic, assertive, adventurous, confident",
    ]

    def __init__(self, username, model, system_prompt):
        self.username = username
        self.last_ts = None
        self.state = None
        self.uuid = None

        self.model = model
        self.system_prompt = system_prompt
        self.browser: Chrome

    def next(self):
        ts = time.time()
        if not self.last_ts:
            self.last_ts = ts
        td = ts - self.last_ts
        context = {
            "td": td,
            "game_type": RoomStatus.QUIPLASH3,
        }
        _state = self.state.next(self, context)
        if _state:
            print(f"[{self.username}] {self.state!s} -> {_state!s}")
            self.state = _state
            _state.enter(self, context)
        self.last_ts = ts

    def play(self, context):
        try:
            _game_state = self.game_state.next(self, context)
            if _game_state:
                print(f"[{self.username}] PlayingGame: {self.game_state!s} -> {_game_state!s}")
                self.game_state = _game_state
                self.think()
        except Exception as e:
            print("Error in game loop")
            print(traceback.format_exc())
            print("~" * 120)
            # print(self.browser.page_source)
            print("~" * 120, "TIMEOUT!", self.username)
            self.state = Timeout()
            self.game_timeout()

    def capture_uuid(self):
        js = "return window.localStorage.getItem('tv:uuid')"
        self.uuid = self.browser.execute_script(js)

    ##################################################################

    # def login(self, room):
    #     self.room = room
    #     opt = selenium.webdriver.ChromeOptions()
    #     # opt.add_argument("--headless")
    #     # opt.add_argument("--disable-gpu")
    #     # opt.add_argument("--headless")
    #     opt.add_argument("--no-sandbox")
    #     opt.add_argument("--enable-javascript")
    #     # opt.add_argument("--incognito")
    #     # opt.add_argument("--nogpu")
    #     # opt.add_argument("--disable-gpu")
    #     # opt.add_argument("--window-size=1280,1280")
    #     # opt.add_experimental_option("excludeSwitches", ["enable-automation"])
    #     # opt.add_experimental_option("useAutomationExtension", False)
    #     # opt.add_argument("--disable-blink-features=AutomationControlled")

    #     self.browser = selenium.webdriver.Chrome(options=opt)  # options=opt
    #     self.state = Started()

    # self.browser.execute_cdp_cmd(
    #     "Page.addScriptToEvaluateOnNewDocument",
    #     {
    #         "source": """
    #             const sockets = [];
    #             const nativeWebSocket = window.WebSocket;
    #             window.WebSocket = function(...args){
    #               const socket = new nativeWebSocket(...args);
    #               sockets.push(socket);
    #               return socket;
    #             };
    #         """
    #     },
    # )

    def load(self):
        opt = selenium.webdriver.ChromeOptions()
        opt.add_argument("--no-sandbox")
        opt.add_argument("--enable-javascript")
        self.browser = selenium.webdriver.Chrome(options=opt)
        self.browser.get("https://jackbox.tv")

    def close(self):
        self.browser.close()

    # answered same as another player in final round
    # <span id="quiplash-submit-alert" class="alert alert-info" style="">You entered the same thing as someone else! Try again.</span>

    def get_by_id(self, element_id):
        try:
            return self.browser.find_element(By.ID, element_id)
        except selenium.common.exceptions.NoSuchElementException:
            return None

    def get_by_class(self, class_name):
        return self.browser.find_elements(By.CLASS_NAME, class_name)

    def active(self):
        # api.active(self.username)
        pass

    def release(self):
        # api.release(self.username)
        pass

    def think(self):
        # api.think(self.username, str(self.game_state))
        pass

    def force_quit(self):
        self.state = ForceQuitting()

    def is_vip(self):
        raise NotImplementedError

    def game_timeout(self):
        raise NotImplementedError

    @property
    def start_button(self):
        raise NotImplementedError

    @property
    def join_button(self):
        return self.get_by_id("button-join")

    @property
    def roomcode_field(self):
        return self.get_by_id("roomcode")

    @property
    def username_field(self):
        return self.get_by_id("username")

    @property
    def status_text(self):
        status = self.get_by_class("status")
        if status:
            return status[0].text.lower()

    @property
    def modal_text(self):
        modal = self.get_by_class("swal2-title")
        if modal:
            return modal[0].text.lower()

    def start(self, room, pilot=False):
        signal.signal(signal.SIGINT, lambda *_: self.force_quit())
        self.room = room
        self.state = Started()
        while True:
            try:
                self.next()
            except selenium.common.exceptions.NoSuchWindowException:
                print("window closed, exiting")
                return
            except Exception as e:
                print("Error in run loop")
                print(traceback.format_exc())
            if pilot:
                code.interact(local=locals())
            if isinstance(self.state, TerminalState):
                return
            time.sleep(1.0 / TICK_RATE)
