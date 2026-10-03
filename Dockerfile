FROM python:3.13-slim
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev
COPY tidal.py stations.py generate_calendar_data.py server.py ./
COPY docs ./docs
ENV HOST=0.0.0.0 PORT=8000 CACHE_DIR=/app/.cache/calendars
EXPOSE 8000
CMD [".venv/bin/python", "server.py"]
