FROM docker:27-cli AS docker_cli

FROM geops-v2-installer-lab:20261024
COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker_cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN mkdir -p /usr/libexec/docker/cli-plugins && ln -s /usr/local/libexec/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-compose
COPY --chmod=755 docker-adapter.py /usr/bin/docker
