from __future__ import annotations

import asyncio
import json
import os
import socket
import sys

import uvicorn

from petdock_runtime.config import RuntimeConfig
from petdock_runtime.server import create_app


async def run() -> None:
    config = RuntimeConfig.from_environment()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    listener.setblocking(False)
    port = listener.getsockname()[1]

    server: uvicorn.Server

    def request_shutdown() -> None:
        server.should_exit = True

    app = create_app(config, request_shutdown)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            access_log=False,
            log_level="warning",
        )
    )

    print(
        json.dumps(
            {
                "type": "ready",
                "protocolVersion": 1,
                "port": port,
                "pid": os.getpid(),
                "backend": config.resolved_backend,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    await server.serve(sockets=[listener])


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except Exception as error:
        print(f"Runtime failed: {error}", file=sys.stderr, flush=True)
        raise
