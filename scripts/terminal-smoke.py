"""Stdlib PTY driver for terminal-smoke.mjs; no application logic or real runtime state."""
import codecs
import fcntl
import json
import os
import pathlib
import pty
import re
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import urllib.request

BIN, ROOT, PORT, REPORT = sys.argv[1:]
OUT = pathlib.Path(REPORT).parent
OUT.mkdir(parents=True, exist_ok=True)
NODE = os.environ.get('NUAAI_NODE', 'node')


def fixture(path, value=None):
    data = None if value is None else json.dumps(value).encode()
    req = urllib.request.Request('http://127.0.0.1:' + PORT + '/__smoke/' + path, data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)


class Screen:
    """Small VT observer: interprets cursor/erase/alternate-screen operations, not raw-text snapshots."""
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.primary = [[' '] * cols for _ in range(rows)]
        self.alternate = [[' '] * cols for _ in range(rows)]
        self.alt = False
        self.entered = self.left = False
        self.visible = True
        self.row = self.col = 0
        self.saved = (0, 0)
        self.pending = ''
        self.last_cell = None
        self.join_next = False
        self.regional_pending = False
        self.scrolls = 0
        self.phase = 'startup'
        self.scrolls_by_phase = {'startup': 0, 'resize': 0, 'steady': 0}
        self.primary_scrollback_erased = False
        self.decoder = codecs.getincrementaldecoder('utf-8')('replace')

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        for name in ['primary', 'alternate']:
            old = getattr(self, name)
            setattr(self, name, [(line[:cols] + [' '] * cols)[:cols] for line in old[:rows]] + [[' '] * cols for _ in range(max(0, rows - len(old)))])
        self.row, self.col = min(self.row, rows - 1), min(self.col, cols - 1)

    @property
    def grid(self):
        return self.alternate if self.alt else self.primary

    def text(self):
        return '\n'.join(''.join(row).rstrip() for row in self.grid)

    def newline(self):
        self.row += 1
        if self.row >= self.rows:
            self.grid.pop(0)
            self.grid.append([' '] * self.cols)
            self.row = self.rows - 1
            if self.alt:
                self.scrolls += 1
                self.scrolls_by_phase[self.phase] += 1

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        while self.pending:
            text = self.pending
            if text.startswith('\x1b['):
                match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', text)
                if not match:
                    return
                params, _, op = match.groups()
                self.pending = text[match.end():]
                private = params.startswith('?')
                values = [int(item or '0') for item in params.lstrip('?').split(';') if item.isdigit() or item == '']
                n = (values[0] if values else 0) or 1
                if op in 'ABCDGHfJK':
                    self.last_cell = None
                    self.join_next = self.regional_pending = False
                if private and op in 'hl':
                    for value in values:
                        if value in [47, 1047, 1049]:
                            if op == 'h':
                                self.saved = (self.row, self.col)
                                self.alt = self.entered = True
                                self.row = self.col = 0
                                self.alternate = [[' '] * self.cols for _ in range(self.rows)]
                            else:
                                self.alt = False
                                self.left = True
                                self.row, self.col = self.saved
                        if value == 25:
                            self.visible = op == 'h'
                elif op in 'Hf':
                    self.row = max(0, min(self.rows - 1, n - 1))
                    self.col = max(0, min(self.cols - 1, (values[1] if len(values) > 1 else 1) - 1))
                elif op == 'A': self.row = max(0, self.row - n)
                elif op == 'B': self.row = min(self.rows - 1, self.row + n)
                elif op == 'C': self.col = min(self.cols - 1, self.col + n)
                elif op == 'D': self.col = max(0, self.col - n)
                elif op == 'G': self.col = max(0, min(self.cols - 1, n - 1))
                elif op == 'J':
                    value = values[0] if values else 0
                    if value == 3 and not self.alt:
                        self.primary_scrollback_erased = True
                    if value == 2:
                        for row in self.grid: row[:] = [' '] * self.cols
                    elif value == 0:
                        self.grid[self.row][self.col:] = [' '] * (self.cols - self.col)
                        for row in self.grid[self.row + 1:]: row[:] = [' '] * self.cols
                elif op == 'K':
                    value = values[0] if values else 0
                    if value == 2: self.grid[self.row][:] = [' '] * self.cols
                    elif value == 1: self.grid[self.row][:self.col + 1] = [' '] * (self.col + 1)
                    else: self.grid[self.row][self.col:] = [' '] * (self.cols - self.col)
                continue
            if text.startswith('\x1b]'):
                match = re.search(r'\x07|\x1b\\', text)
                if not match: return
                self.pending = text[match.end():]
                continue
            if text[0] == '\x1b':
                if len(text) < 2: return
                self.pending = text[2:]
                continue
            char, self.pending = text[0], text[1:]
            if char == '\r':
                self.col = 0
                self.last_cell = None
                self.join_next = self.regional_pending = False
            elif char == '\n':
                self.newline()
                self.last_cell = None
                self.join_next = self.regional_pending = False
            elif char == '\b': self.col = max(0, self.col - 1)
            elif char >= ' ' and char != '\x7f':
                # A ZWJ sequence, flag pair and skin modifier occupy one grapheme,
                # not one terminal cell allocation per Unicode codepoint.
                import unicodedata
                regional = 0x1f1e6 <= ord(char) <= 0x1f1ff
                modifier = 0x1f3fb <= ord(char) <= 0x1f3ff
                continuation = self.join_next or (regional and self.regional_pending)
                if unicodedata.combining(char) or char in '\u200d\ufe0f' or modifier or continuation:
                    if self.last_cell is not None:
                        row, col = self.last_cell
                        self.grid[row][col] += char
                    self.join_next = char == '\u200d'
                    if regional: self.regional_pending = False
                    continue
                self.regional_pending = regional
                width = 2 if unicodedata.east_asian_width(char) in 'WF' or ord(char) >= 0x1f000 else 1
                if self.col + width > self.cols:
                    self.col = 0
                    self.newline()
                self.grid[self.row][self.col] = char
                self.last_cell = (self.row, self.col)
                self.col += width


results = []

def case(label, arguments, mode):
    fixture('reset', {'crash': mode == 'exception'})
    case_env = dict(os.environ)
    if mode == 'onboard':
        onboard_root = pathlib.Path(ROOT).parent / 'onboard-runtime'
        onboard_root.mkdir()
        case_env['NUAAI_ROOT'] = str(onboard_root)
        subprocess.run([NODE, BIN, 'init'], env=case_env, capture_output=True, check=True)
        config_path = onboard_root / '.nuaai/config.json'
        config = json.loads(config_path.read_text())
        with socket.socket() as port_socket:
            port_socket.bind(('127.0.0.1', 0))
            config['port'] = port_socket.getsockname()[1]
        case_env['NUAAI_PORT'] = str(config['port'])
        config['features'].update(ollama=False, codex=False, matrix=False, browser=False, search=False)
        config_path.write_text(json.dumps(config))
    master, slave = pty.openpty()
    rows, cols = (60 if mode == 'onboard' else 32), 80
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    before = termios.tcgetattr(slave)
    screen = Screen(rows, cols)
    raw = bytearray()

    cmd = 'printf "BEFORE_TUI_SENTINEL\\n"; ' + shlex.join([NODE, BIN] + arguments) + '; code=$?; printf "\\nAFTER_TUI_SENTINEL status=%s\\n" "$code"'
    child = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-c', cmd], stdin=slave, stdout=slave, stderr=slave, env=case_env, cwd=case_env['NUAAI_ROOT'], start_new_session=True)

    def app_pid():
        children = pathlib.Path(f'/proc/{child.pid}/task/{child.pid}/children').read_text().split()
        assert len(children) == 1, 'Expected exactly one foreground CLI child'
        return int(children[0])

    def pump(timeout=.05):
        if select.select([master], [], [], timeout)[0]:
            data = os.read(master, 65536)
            raw.extend(data)
            screen.feed(data)

    def wait(predicate, description, timeout=15):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            pump()
            if predicate(): return
            if child.poll() is not None: break
        raise AssertionError(label + ': missing ' + description + '\n' + screen.text() + '\nraw tail=' + repr(bytes(raw[-1000:])))

    def send(data):
        before_scrolls = screen.scrolls_by_phase['steady']
        os.write(master, data if isinstance(data, bytes) else data.encode())
        until = time.monotonic() + .2
        while time.monotonic() < until: pump(.02)
        if screen.scrolls_by_phase['steady'] != before_scrolls:
            (OUT / ('overflow-' + label + '.txt')).write_text(repr(data) + '\n' + screen.text())
            raise AssertionError(f'Steady overflow after {data!r}: {screen.scrolls_by_phase}')

    def resize(height, width):
        screen.phase = 'resize'
        screen.resize(height, width)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', height, width, 0, 0))
        os.kill(app_pid(), signal.SIGWINCH)
        until = time.monotonic() + .4
        while time.monotonic() < until: pump(.02)
        screen.phase = 'steady'

    try:
        if mode == 'onboard':
            for prompt in ['Enable Ollama', 'Enable Codex', 'Enable Matrix', 'Enable local SearXNG', 'Enable Playwright']:
                wait(lambda: prompt.encode() in raw, prompt)
                send(b'n\n')
            wait(lambda: b'Primary provider' in raw, 'provider prompt')
            send(b'ollama\n')
            wait(lambda: b'After setup:' in raw, 'onboarding launch prompt')
            send(b'tui\n')
        if mode == 'exception':
            wait(lambda: b'AFTER_TUI_SENTINEL' in raw, 'exception return')
            assert b'Invalid time value' in raw, 'Expected real render exception was not reached'
        else:
            wait(lambda: 'Connected' in screen.text() and (mode == 'onboard' or 'Ctrl-Y' in screen.text()), 'connected approval frame')
            screen.phase = 'steady'
            if mode == 'interaction':
                for index, line in enumerate(['draft one', 'draft two', 'draft three', 'draft four', 'draft five']):
                    if index: send(b'\x1b\r')
                    send(line)
                resize(16, 38)
                wait(lambda: 'draft five' in screen.text() and 'Ctrl-Y' in screen.text() and 'Ctrl-N' in screen.text(), 'bounded small frame')
                # Ink's resize listener can repaint the old React tree before the
                # size hook commits. Judge the settled frame, then exercise it.
                screen.scrolls = 0
                send(b'\x1b[D')
                send(b'\x1b[C')
                (OUT / 'terminal-small-frame.txt').write_text(screen.text())
                # No overflow/scrolling is allowed in the alternate-screen frame.
                assert screen.scrolls == 0, f'Alternate frame scrolled {screen.scrolls} times'
                resize(6, 28)
                wait(lambda: 'Resize' in screen.text(), 'minimum-size fallback')
                (OUT / 'terminal-minimum-frame.txt').write_text(screen.text())
                resize(32, 80)
                wait(lambda: 'draft five' in screen.text() and 'Ctrl-Y' in screen.text(), 'draft and approval after resize')
            if mode in ['interaction', 'unicode']:
                send(b'\x0e')  # Ctrl-N: deny only the exact controlled fixture payload.
                wait(lambda: any(item['path'].endswith('/pty-approval/deny') for item in fixture('requests')), 'approval decision readback')
                if mode == 'interaction':
                    # Exercise installed shortcuts against the actual VT screen and HTTP readback.
                    send(b'\x1bm')
                    wait(lambda: 'Choose model' in screen.text(), 'Alt-M model picker')
                    send(b'\x1b')
                    wait(lambda: 'draft five' in screen.text(), 'draft after model picker')
                    send(b'\x1b[109;5u')
                    wait(lambda: 'Choose model' in screen.text(), 'distinct Ctrl-M model picker')
                    send(b'\x1b')
                    send(b'\x1bh')
                    wait(lambda: 'Commands and shortcuts' in screen.text(), 'shortcut help')
                    send('model')
                    wait(lambda: 'Ctrl-P / Alt-M' in screen.text(), 'searchable model key hint')
                    send(b'\x1b')
                    wait(lambda: 'draft five' in screen.text(), 'draft after shortcut help')
                    send(b'\x0e')
                    wait(lambda: any(item['path'] == '/api/sessions' and item['method'] == 'POST' for item in fixture('requests')), 'Ctrl-N new session readback')
                    wait(lambda: 'draft five' in screen.text(), 'unsent draft carried to new conversation')
                    (OUT / 'terminal-keyboard-frame.txt').write_text(screen.text())
                    send(b'\x15')
                    attached = pathlib.Path(ROOT) / 'PTY attachment.txt'
                    attached.write_text('PTY_ATTACHMENT_BYTES Ω')
                    send('/attach ' + str(attached) + ' ')
                    send(b'\r')
                    wait(lambda: 'Files:' in screen.text(), 'installed attachment summary')
                    resize(14, 38)
                    wait(lambda: 'Resize' in screen.text(), 'attachment minimum-size fallback')
                    before_runs = len([item for item in fixture('requests') if item['path'] == '/api/runs' and item['method'] == 'POST'])
                    send(b'\r')
                    after_runs = len([item for item in fixture('requests') if item['path'] == '/api/runs' and item['method'] == 'POST'])
                    assert after_runs == before_runs, 'A hidden undersized attachment composer submitted a run'
                    resize(32, 80)
                    wait(lambda: 'Files:' in screen.text(), 'attachment restored after resize')
                send(b'\x15')  # Clear long draft, preserving real editor path.
                send('é 🇺🇸 界 👩‍💻')
                highlight_start = len(raw)
                send(b'\x1b[D')
                wait(lambda: b'\x1b[7m' + '👩‍💻'.encode() + b'\x1b[27m' in raw[highlight_start:], 'whole ZWJ grapheme cursor highlight')
                send(b'\x1b[3~')
                send('DONE')
                send(b'\r')
                wait(lambda: any(item['path'] == '/api/runs' and item['body'].get('input') == 'é 🇺🇸 界 DONE' for item in fixture('requests')), 'exact Unicode draft submission')
                send('/quit ')
                send(b'\r')
            elif mode in ['quit', 'onboard']:
                send('/quit ')
                send(b'\r')
            elif mode in ['SIGINT', 'SIGTERM']:
                os.kill(app_pid(), getattr(signal, mode))
            else:
                send(b'\x03')
            wait(lambda: b'AFTER_TUI_SENTINEL' in raw, 'parent-shell continuation')
        child.wait(timeout=5)
        while select.select([master], [], [], .05)[0]: pump(0)
        after = termios.tcgetattr(slave)
        if mode == 'onboard':
            try:
                probe = socket.create_connection(('127.0.0.1', int(case_env['NUAAI_PORT'])), timeout=.5)
            except OSError:
                pass
            else:
                probe.close()
                raise AssertionError('Onboarding-owned daemon remained running after TUI exit')
        assert screen.scrolls_by_phase['steady'] == 0, f"Settled interactive frame overflowed: {screen.scrolls_by_phase}"
        assert before == after, 'Terminal input flags were not restored'
        assert screen.visible, 'Cursor remained hidden'
        inline = '--no-alt-screen' in arguments
        if not inline:
            assert screen.entered and screen.left and not screen.alt, 'Alternate screen lifecycle missing'
            assert 'BEFORE_TUI_SENTINEL' in screen.text(), 'Original parent screen not restored'
            assert 'Ctrl-Y' not in screen.text(), 'Application frame leaked into parent screen'
        else:
            assert not screen.entered, 'Inline opt-out entered alternate screen'
        assert not screen.primary_scrollback_erased, 'Must not erase primary shell scrollback'
        match = re.search(rb'AFTER_TUI_SENTINEL status=(\d+)', raw)
        assert match and int(match[1]) == (1 if mode == 'exception' else 0), 'Unexpected application exit status'
        results.append({'case': label, 'status': 'passed', 'applicationExitCode': int(match[1]), 'parentShellContinued': True, 'ttyAttributesRestored': True, 'cursorRestored': True, 'alternateScreenEntered': screen.entered, 'alternateScreenExited': screen.left, 'priorScreenRestored': not inline, 'alternateScrolls': screen.scrolls, 'scrollsByPhase': screen.scrolls_by_phase})
    except Exception as error:
        results.append({'case': label, 'status': 'failed', 'error': str(error)})
        raise
    finally:
        (OUT / ('terminal-' + label + '.ansi')).write_bytes(raw)
        if child.poll() is None:
            try:
                application = app_pid()
                os.kill(application, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.kill(application, signal.SIGKILL)
            except (ProcessLookupError, AssertionError): pass
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
        os.close(master)
        os.close(slave)


try:
    count = len(fixture('requests'))
    for args, code in [(['--help'], 0), (['not-a-command'], 1), (['tui', '--unknown'], 1)]:
        result = subprocess.run([NODE, BIN] + args, env=os.environ, capture_output=True, timeout=10)
        assert result.returncode == code
        assert (b'Usage:' in result.stdout) if code == 0 else (b'Unknown' in result.stderr)
        assert b'\x1b[' not in result.stdout + result.stderr
    # The GET below adds one observer request; no CLI request may have occurred.
    assert len(fixture('requests')) == count + 1, 'Help/error contacted daemon fixture'
    for label, args, mode in [('default-ctrl-c', [], 'ctrl-c'), ('explicit-quit', ['tui'], 'quit'), ('signal-int', ['tui'], 'SIGINT'), ('signal-term', ['tui'], 'SIGTERM'), ('inline-opt-out', ['tui', '--no-alt-screen'], 'ctrl-c'), ('render-exception', ['tui'], 'exception'), ('unicode-approval', ['tui'], 'unicode'), ('onboard-quit', ['onboard'], 'onboard'), ('resize-unicode-approval', ['tui'], 'interaction')]:
        case(label, args, mode)
finally:
    pathlib.Path(REPORT).write_text(json.dumps({'installedBin': BIN, 'isolatedRoot': ROOT, 'results': results}, indent=2) + '\n')
print(json.dumps({'passed': len(results), 'report': REPORT}, indent=2))
