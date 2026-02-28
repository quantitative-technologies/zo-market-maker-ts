.PHONY: build start stop restart logs ps clean
.PHONY: start-sol start-btc start-eth
.PHONY: stop-sol stop-btc stop-eth
.PHONY: logs-sol logs-btc logs-eth

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

# Per-symbol targets
start-sol:
	docker compose up -d --build mm-sol

start-btc:
	docker compose up -d --build mm-btc

start-eth:
	docker compose up -d --build mm-eth

stop-sol:
	docker compose stop mm-sol

stop-btc:
	docker compose stop mm-btc

stop-eth:
	docker compose stop mm-eth

logs-sol:
	docker compose logs -f mm-sol

logs-btc:
	docker compose logs -f mm-btc

logs-eth:
	docker compose logs -f mm-eth
