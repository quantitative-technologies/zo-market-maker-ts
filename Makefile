.PHONY: build start stop restart logs ps clean

build:
	docker compose build

start:
	docker compose up -d --build

stop:
	docker compose down

restart:
	docker compose down
	docker compose up -d --build

logs:
	docker compose logs -f

ps:
	docker compose ps

clean:
	docker compose down --rmi local
