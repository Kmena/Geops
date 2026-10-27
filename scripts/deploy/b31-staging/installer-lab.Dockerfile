FROM python:3.12
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends sudo >/dev/null && rm -rf /var/lib/apt/lists/*
