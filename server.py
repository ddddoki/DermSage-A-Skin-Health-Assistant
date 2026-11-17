"""Serve DermSage's browser interface, record store and inference routes."""

import argparse
import asyncio
import json
import logging
import re
import sqlite3
from contextlib import asynccontextmanager, closing
from datetime import datetime, timedelta, timezone
from html import escape
from pathlib import Path
from uuid import uuid4

import uvicorn
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from starlette.convertors import StringConvertor, register_url_convertor
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect

from inference import router as inference_router


ROOT = Path(__file__).resolve().parent
DATABASE = ROOT / 'data' / 'dermsage.sqlite3'
LOGGER = logging.getLogger('uvicorn.error')
STATIC_FILES = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/index.html': ('index.html', 'text/html; charset=utf-8'),
    '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
    '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
    '/DermSage-logo.png': ('DermSage-logo.png', 'image/png'),
}
RECORDS_PATH = '/api/records'
IMPORT_PATH = '/api/records/import'
ITEM_PATH = '/api/records/{record_id:recordid}'
RECORD_ID = re.compile(r'[0-9a-f]{32}')
ISO_UTC_MILLISECONDS = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z')
TEXT_LIMITS = {'title': 80, 'region': 60, 'description': 800}
TOPICS = {'general', 'urticaria', 'psoriasis', 'fungal', 'acne', 'dermatitis'}
RECORD_FIELDS = TEXT_LIMITS.keys() | {'days', 'topic'}
IMPORT_FIELDS = RECORD_FIELDS | {'id', 'createdAt', 'updatedAt'}
MAX_REQUEST_BYTES = 16 * 1024
MAX_IMPORT_BYTES = 8 * 1024 * 1024
MAX_IMPORT_RECORDS = 2000
INSERT_RECORD = '''
    INSERT INTO records (id, title, region, days, description, topic, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
'''


class RequestError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def open_database(path):
    connection = sqlite3.connect(path, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def initialize_database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(open_database(path)) as db, db:
        db.execute('''
            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                region TEXT NOT NULL,
                days INTEGER CHECK (days BETWEEN 0 AND 3650),
                description TEXT NOT NULL,
                topic TEXT NOT NULL,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            )
        ''')


def read_record_fields(data, updating=False, *, importing=False):
    expected = RECORD_FIELDS | {'expectedUpdatedAt'} if updating else RECORD_FIELDS
    if importing:
        expected = IMPORT_FIELDS
    if not isinstance(data, dict) or data.keys() != expected:
        raise RequestError(400, '记录字段有误，请刷新页面后重试。')

    text = {}
    for field, limit in TEXT_LIMITS.items():
        value = data[field]
        if not isinstance(value, str):
            raise RequestError(400, '标题、部位和症状描述应为文本。')
        try:
            length = len(value.encode('utf-16-le')) // 2
        except UnicodeError as exc:
            raise RequestError(400, '记录包含无法保存的字符。') from exc
        if length > limit:
            raise RequestError(400, '标题、部位或症状描述超过字数上限。')
        text[field] = value if importing else value.strip()
    if not text['title'].strip():
        raise RequestError(400, '请填写记录标题。')

    days = data['days']
    if days is not None and (type(days) is not int or not 0 <= days <= 3650):
        raise RequestError(400, '持续天数请填写 0 至 3650 的整数，或留空。')
    topic = data['topic']
    if not isinstance(topic, str) or topic not in TOPICS:
        raise RequestError(400, '记录主题有误，请重新查看匹配结果。')
    if updating and (not isinstance(data['expectedUpdatedAt'], str) or len(data['expectedUpdatedAt']) != 24):
        raise RequestError(400, '记录版本有误，请重新载入记录。')
    return text['title'], text['region'], days, text['description'], topic


def valid_record_timestamp(value):
    if not isinstance(value, str) or not ISO_UTC_MILLISECONDS.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        return False
    return True


def read_import_records(data):
    if not isinstance(data, dict) or type(data.get('schemaVersion')) is not int or data['schemaVersion'] != 1:
        raise RequestError(400, '请选择数据版本为 1 的 DermSage JSON 导出文件。')
    records = data.get('records')
    if not isinstance(records, list):
        raise RequestError(400, '导出文件缺少有效的记录列表。')
    if len(records) > MAX_IMPORT_RECORDS:
        raise RequestError(413, f'单次最多导入 {MAX_IMPORT_RECORDS} 条记录。')

    rows = []
    for number, record in enumerate(records, 1):
        try:
            fields = read_record_fields(record, importing=True)
            record_id = record['id']
            created = record['createdAt']
            updated = record['updatedAt']
            if not isinstance(record_id, str) or not RECORD_ID.fullmatch(record_id):
                raise RequestError(400, '记录编号格式有误。')
            if not valid_record_timestamp(created) or not valid_record_timestamp(updated) or created > updated:
                raise RequestError(400, '记录的创建时间或更新时间有误。')
        except RequestError as exc:
            raise RequestError(400, f'第 {number} 条记录无法导入。{exc}') from exc
        rows.append((record_id, *fields, created, updated))
    return rows


def timestamp(after=None):
    now = datetime.now(timezone.utc)
    if after:
        previous = datetime.fromisoformat(after.replace('Z', '+00:00'))
        try:
            now = max(now, previous + timedelta(milliseconds=1))
        except OverflowError as exc:
            raise RequestError(409, '此记录的更新时间超出可更新范围。') from exc
    return now.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class RecordIdConvertor(StringConvertor):
    regex = RECORD_ID.pattern


register_url_convertor('recordid', RecordIdConvertor())


@asynccontextmanager
async def lifespan(application):
    await run_in_threadpool(initialize_database, application.state.database)
    yield


app = FastAPI(
    title='DermSage 本机接口', version='1.0', docs_url=None, redoc_url=None,
    redirect_slashes=False, lifespan=lifespan,
)
app.state.database = DATABASE
app.include_router(inference_router)


def check_origin(request):
    hosts = request.headers.getlist('host')
    address = request.scope.get('server')
    port = address[1] if address else 80
    allowed = {f'127.0.0.1:{port}', f'localhost:{port}'}
    if port == 80:
        allowed.update(('127.0.0.1', 'localhost'))
    if len(hosts) != 1 or hosts[0].lower() not in allowed:
        raise RequestError(403, '请通过本机服务地址访问 DermSage。')
    origins = request.headers.getlist('origin')
    if origins and origins != [f'http://{hosts[0].lower()}']:
        raise RequestError(403, '仅允许从 DermSage 当前页面发送此请求。')
    if request.method in ('POST', 'PUT', 'DELETE') and request.headers.get('sec-fetch-site') in ('cross-site', 'same-site'):
        raise RequestError(403, '仅允许从 DermSage 当前页面修改记录。')


def error_response(status, message, headers=None):
    return JSONResponse({'error': message}, status_code=status, headers=headers)


@app.middleware('http')
async def guard_local_requests(request, call_next):
    try:
        check_origin(request)
        response = await call_next(request)
    except RequestError as exc:
        response = error_response(exc.status, str(exc))
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    return response


@app.exception_handler(RequestError)
async def handle_request_error(request, exc):
    return error_response(exc.status, str(exc))


@app.exception_handler(HTTPException)
async def handle_http_error(request, exc):
    messages = {404: '找不到所请求的页面或接口。', 405: '此接口不支持该请求方法。'}
    detail = exc.detail
    if isinstance(detail, dict) and isinstance(detail.get('error'), str):
        return JSONResponse(detail, status_code=exc.status_code, headers=exc.headers)
    message = messages.get(exc.status_code, detail if isinstance(detail, str) else '请求格式不受支持。')
    return error_response(exc.status_code, message, exc.headers)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(request, exc):
    return error_response(400, '请求字段有误，请检查输入后重试。')


@app.exception_handler(sqlite3.Error)
@app.exception_handler(OSError)
async def handle_storage_error(request, exc):
    LOGGER.error('Local request failed: %s', exc)
    return error_response(500, '本地服务暂时无法处理请求，请稍后重试。')


async def read_json(request, max_bytes=MAX_REQUEST_BYTES):
    if request.headers.get('transfer-encoding'):
        raise RequestError(400, '请求传输格式不受支持。')
    if request.headers.get('content-type', '').partition(';')[0].strip().lower() != 'application/json':
        raise RequestError(415, '记录数据应使用 JSON 格式。')
    lengths = request.headers.getlist('content-length')
    if len(lengths) != 1 or not re.fullmatch(r'[0-9]{1,10}', lengths[0]):
        raise RequestError(400, '请求长度有误。')
    length = int(lengths[0])
    too_large = '导入文件不能超过 8 MB。' if max_bytes == MAX_IMPORT_BYTES else '记录数据超过大小限制。'
    if length > max_bytes:
        raise RequestError(413, too_large)

    async def receive_body():
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > max_bytes:
                raise RequestError(413, too_large)
            raw.extend(chunk)
        return raw

    try:
        raw = await asyncio.wait_for(receive_body(), timeout=10)
    except TimeoutError as exc:
        raise RequestError(408, '接收数据超时，请重试。') from exc
    except ClientDisconnect as exc:
        raise RequestError(400, '未收到完整的记录数据。') from exc
    if len(raw) != length:
        raise RequestError(400, '未收到完整的记录数据。')
    try:
        return json.loads(raw.decode('utf-8-sig'))
    except (ValueError, RecursionError) as exc:
        raise RequestError(400, '无法读取记录数据，请刷新页面后重试。') from exc


def save_record(database, fields, record_id=None, expected=None):
    with closing(open_database(database)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        if record_id is None:
            record_id = uuid4().hex
            now = timestamp()
            db.execute(INSERT_RECORD, (record_id, *fields, now, now))
        else:
            current = db.execute('SELECT updatedAt FROM records WHERE id = ?', (record_id,)).fetchone()
            if current is None or current['updatedAt'] != expected:
                raise RequestError(409, '记录已修改或删除，请重新载入后再试。')
            db.execute('''
                UPDATE records SET title = ?, region = ?, days = ?, description = ?, topic = ?, updatedAt = ?
                WHERE id = ?
            ''', (*fields, timestamp(after=expected), record_id))
        return dict(db.execute('SELECT * FROM records WHERE id = ?', (record_id,)).fetchone())


def merge_records(database, rows):
    with closing(open_database(database)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        db.executemany(INSERT_RECORD + 'ON CONFLICT(id) DO NOTHING', rows)
        imported = db.total_changes
    return {'imported': imported, 'skipped': len(rows) - imported}


@app.head(RECORDS_PATH, include_in_schema=False)
@app.get(RECORDS_PATH, summary='列出记录')
def list_records(request: Request):
    with closing(open_database(request.app.state.database)) as db:
        return {'records': [dict(row) for row in db.execute('SELECT * FROM records ORDER BY updatedAt DESC, id DESC')]}


@app.post(RECORDS_PATH, status_code=201, summary='新建记录')
async def create_record(request: Request):
    fields = read_record_fields(await read_json(request))
    record = await run_in_threadpool(save_record, request.app.state.database, fields)
    return {'record': record}


@app.post(IMPORT_PATH, summary='导入记录')
async def import_records(request: Request):
    data = await read_json(request, MAX_IMPORT_BYTES)
    rows = await run_in_threadpool(read_import_records, data)
    return await run_in_threadpool(merge_records, request.app.state.database, rows)


@app.put(ITEM_PATH, summary='更新记录')
async def update_record(request: Request, record_id: str):
    data = await read_json(request)
    fields = read_record_fields(data, updating=True)
    record = await run_in_threadpool(save_record, request.app.state.database, fields, record_id, data['expectedUpdatedAt'])
    return {'record': record}


@app.delete(ITEM_PATH, status_code=204, summary='删除记录')
def delete_record(request: Request, record_id: str):
    with closing(open_database(request.app.state.database)) as db, db:
        db.execute('DELETE FROM records WHERE id = ?', (record_id,))
    return Response(status_code=204)


@app.delete(RECORDS_PATH, status_code=204, summary='清空记录')
def clear_records(request: Request):
    with closing(open_database(request.app.state.database)) as db, db:
        db.execute('DELETE FROM records')
    return Response(status_code=204)


@app.get('/docs', response_class=HTMLResponse, include_in_schema=False)
def api_docs():
    rows = []
    for path, operations in app.openapi()['paths'].items():
        for method, operation in operations.items():
            rows.append(f'<tr><td>{method.upper()}</td><td><code>{escape(path)}</code></td><td>{escape(operation["summary"])}</td></tr>')
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DermSage 接口文档</title>
<style>body{font:16px system-ui;margin:3rem auto;padding:0 1rem;max-width:52rem;color:#163643}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.7rem;border-bottom:1px solid #cadad7}</style>
<h1>DermSage 接口文档</h1><p><a href="/openapi.json">查看 OpenAPI 规范</a></p>
<table><thead><tr><th>方法</th><th>路径</th><th>用途</th></tr></thead><tbody>''' + ''.join(rows) + '</tbody></table></html>'


def serve_static(request: Request):
    name, media_type = STATIC_FILES[request.url.path]
    path = ROOT / name
    if not path.is_file():
        raise RequestError(404, '本地页面文件缺失。')
    return FileResponse(path, media_type=media_type)


for static_path in STATIC_FILES:
    app.add_api_route(static_path, serve_static, methods=['GET', 'HEAD'], include_in_schema=False)


def main():
    parser = argparse.ArgumentParser(description='启动 DermSage 本地服务。')
    parser.add_argument('--port', type=int, default=8765, help='本地服务端口，默认 8765')
    parser.add_argument('--db', type=Path, default=DATABASE, help='SQLite 数据库文件路径')
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('端口必须是 0 至 65535 的整数。')

    app.state.database = args.db.resolve()
    config = uvicorn.Config(app, host='127.0.0.1', port=args.port, proxy_headers=False, ws='none')
    server = uvicorn.Server(config)
    with config.bind_socket() as listener:
        try:
            server.run(sockets=[listener])
        except KeyboardInterrupt:
            return
    if not server.started:
        parser.exit(1, '无法启动 DermSage 本地服务。\n')


if __name__ == '__main__':
    main()
