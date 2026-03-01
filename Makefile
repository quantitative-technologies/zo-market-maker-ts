.PHONY: build start stop restart logs ps clean
.PHONY: start-sol start-btc start-eth start-hype start-xrp start-sui
.PHONY: stop-sol stop-btc stop-eth stop-hype stop-xrp stop-sui
.PHONY: logs-sol logs-btc logs-eth logs-hype logs-xrp logs-sui
.PHONY: monitor-sol monitor-btc monitor-eth monitor-hype monitor-xrp monitor-sui
.PHONY: t2t-dist

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

start-hype:
	docker compose up -d --build mm-hype

start-xrp:
	docker compose up -d --build mm-xrp

start-sui:
	docker compose up -d --build mm-sui

stop-sol:
	docker compose stop mm-sol

stop-btc:
	docker compose stop mm-btc

stop-eth:
	docker compose stop mm-eth

stop-hype:
	docker compose stop mm-hype

stop-xrp:
	docker compose stop mm-xrp

stop-sui:
	docker compose stop mm-sui

logs-sol:
	docker compose logs -f mm-sol

logs-btc:
	docker compose logs -f mm-btc

logs-eth:
	docker compose logs -f mm-eth

logs-hype:
	docker compose logs -f mm-hype

logs-xrp:
	docker compose logs -f mm-xrp

logs-sui:
	docker compose logs -f mm-sui

monitor-sol:
	npm run monitor -- sol

monitor-btc:
	npm run monitor -- btc

monitor-eth:
	npm run monitor -- eth

monitor-hype:
	npm run monitor -- hype

monitor-xrp:
	npm run monitor -- xrp

monitor-sui:
	npm run monitor -- sui

t2t-dist:
	./scripts/t2t-dist.sh
