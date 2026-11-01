@echo off
rem Starts the PICO-8 bridge for the Code Editor's Run button (keep this window open).
rem Paste the pairing token it prints into the Code Editor: Cart > Set Up Run... (new token on every start).
rem Add more cart folders with --root, e.g.:  python "%~dp0pico8_bridge.py" --root C:\Demos\MyDemo
python "%~dp0pico8_bridge.py" %*
pause

