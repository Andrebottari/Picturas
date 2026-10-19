#AB Imagem Node.js com versão definida.
FROM node:22-bookworm-slim

#AB Instalar FFmpeg e FFprobe para validar vídeos MP4.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

RUN npm install

EXPOSE 11000

CMD ["npm", "start"]