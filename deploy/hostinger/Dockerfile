FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app app
COPY wikitime wikitime
COPY web web
COPY scripts scripts
ENV DB_HOST=db DB_PORT=3306 LANDING=kielipeili
EXPOSE 8000
CMD [".venv/bin/gunicorn", "-w", "3", "--threads", "8", "-b", "0.0.0.0:8000", "--timeout", "120", "--access-logfile", "-", "app.server:app"]
