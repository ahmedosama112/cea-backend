# CEA Backend — صورة إنتاج (Railway / أي منصة Docker)
# مرحلتان: بناء TypeScript ثم صورة تشغيل خفيفة بدون devDependencies

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate
COPY --from=build /app/dist ./dist
COPY scripts/docker-start.sh ./scripts/docker-start.sh
RUN chmod +x ./scripts/docker-start.sh && mkdir -p /app/uploads

EXPOSE 4000
# عند كل إقلاع: تطبيق أي migrations جديدة ثم تشغيل السيرفر
CMD ["./scripts/docker-start.sh"]
