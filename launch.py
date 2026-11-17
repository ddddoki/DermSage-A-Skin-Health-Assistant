"""Start the portable model runtime and the local DermSage service."""

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import ProxyHandler, build_opener


ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / 'runtime'
opener = build_opener(ProxyHandler({}))


def model_runtime_available():
    try:
        with opener.open('http://127.0.0.1:11434/api/tags', timeout=1) as response:
            return isinstance(json.load(response).get('models'), list)
    except (OSError, ValueError, AttributeError):
        return False


def start_portable_runtime():
    binary = RUNTIME / 'ollama' / 'ollama.exe'
    if not binary.is_file():
        print('本机 Ollama 未启动。记录功能可用，模型观察需要先启动 Ollama。', flush=True)
        return None
    environment = os.environ.copy()
    environment.update({
        'OLLAMA_HOST': '127.0.0.1:11434',
        'OLLAMA_MODELS': str(RUNTIME / 'models'),
        'OLLAMA_NO_CLOUD': '1',
        'OLLAMA_VULKAN': '1',
    })
    try:
        process = subprocess.Popen(
            [str(binary), 'serve'], env=environment, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        )
    except OSError:
        print('Ollama 启动失败。记录功能仍可使用。', flush=True)
        return None
    for _ in range(40):
        if process.poll() is not None:
            break
        if model_runtime_available():
            return process
        time.sleep(0.25)
    print('Ollama 尚未就绪。打开页面后可检查模型状态。', flush=True)
    return process


def main():
    runtime = None if model_runtime_available() else start_portable_runtime()
    try:
        return subprocess.call([sys.executable, str(ROOT / 'server.py'), *sys.argv[1:]], cwd=ROOT)
    except KeyboardInterrupt:
        return 0
    finally:
        if runtime is not None and runtime.poll() is None:
            runtime.terminate()
            try:
                runtime.wait(timeout=5)
            except subprocess.TimeoutExpired:
                runtime.kill()
                runtime.wait()


if __name__ == '__main__':
    sys.exit(main())
