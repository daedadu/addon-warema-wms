# Von HA gesetzt, z. B. ghcr.io/home-assistant/aarch64-base:3.19
ARG BUILD_FROM

# --- Stufe 1: npm (serialport etc.) ---
FROM node:18-alpine AS builder

RUN apk add --no-cache python3 make g++ linux-headers

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm rebuild --build-from-source

# --- Stufe 2: HA-Add-on-Image ---
ARG BUILD_FROM
# hadolint ignore=DL3006
FROM ${BUILD_FROM}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache nodejs

WORKDIR /srv

COPY --from=builder /build/node_modules ./node_modules
COPY srv/ ./
COPY etc/ /etc/