FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY video_filters/video_filters.py /app/video_filters.py

CMD ["python", "/app/video_filters.py", "--help"]