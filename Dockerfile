FROM --platform=linux/amd64 node:22

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git curl python3 python3-pip \
  build-essential gnupg ca-certificates \
  lsb-release \
  && rm -rf /var/lib/apt/lists/*

COPY third_party/depot_tools /depot_tools
ENV PATH="/depot_tools:${PATH}"

WORKDIR /app

# Install Node.js 20.x and npm
COPY package.json /app/
RUN npm install 

#RUN pip install vpython

ENV GYP_DEFINES="target_arch=x64"

COPY .gclient /app/
RUN gclient sync

# Set workdir to devtools-frontend
WORKDIR /app/mock-tetra-ii


RUN npm run build

# Expose port for Python HTTP server
EXPOSE 8000

# Default: serve the built frontend
CMD ["python3", "-m", "http.server", "8000", "--directory", "out/Default/gen/front_end"]







