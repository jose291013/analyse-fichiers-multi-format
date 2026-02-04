FROM node:18-slim

# Installer qpdf, ghostscript, ImageMagick et rsvg-convert (pour SVG → PDF)
RUN apt-get update && apt-get install -y \
    qpdf \
    ghostscript \
    imagemagick \
    librsvg2-bin \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Créer tous les dossiers nécessaires
RUN mkdir -p /app/uploads /app/pdfs /app/modified /app/thumbnails

EXPOSE 3000

CMD ["node", "server.js"]



