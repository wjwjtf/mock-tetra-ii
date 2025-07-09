FROM --platform=linux/amd64 ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git curl python3 python3-pip python-is-python3 \
  build-essential gnupg ca-certificates \
  lsb-release \
  && rm -rf /var/lib/apt/lists/*

# Install depot_tools (for gclient, etc.)
RUN git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git /depot_tools
ENV PATH="/depot_tools:${PATH}"

WORKDIR /app

# Install Node.js 20.x and npm
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm

#RUN pip install vpython

ENV GYP_DEFINES="target_arch=x64"

COPY .gclient /app/
RUN gclient sync

# Set workdir to devtools-frontend
WORKDIR /app/mock-tetra-ii

#cd to the devtools-frontend folder
#RUN cd devtools-frontend

RUN npm run build

# Expose port for Python HTTP server
EXPOSE 8000

# Default: serve the built frontend
CMD ["python3", "-m", "http.server", "8000", "--directory", "out/Default/gen/front_end"]







