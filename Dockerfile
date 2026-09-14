FROM node:24-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
# Vite inlines VITE_* into the bundle at BUILD time, so these must reach the build,
# not just the container at runtime. Coolify adds ARG declarations for the app's env
# vars automatically; declaring them here means the build does not depend on that.
ARG VITE_MAPBOX_STYLE
ARG VITE_MAPBOX_TOKEN
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
