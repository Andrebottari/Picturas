FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY video_filters/requirements.txt /app/requirements.txt

RUN pip install --no-cache-dir -r /app/requirements.txt

COPY video_filters/video_filters.py /app/video_filters.py
COPY video_filters/worker.py /app/worker.py

CMD ["python", "-u", "/app/worker.py"]