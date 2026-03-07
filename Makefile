.PHONY: build start stop restart logs ps clean bench

build:
	docker compose build

start:
	docker compose up -d --build

stop:
	docker compose stop

restart:
	docker compose stop
	docker compose up -d --build

logs:
	docker compose logs -f

ps:
	docker compose ps

clean:
	docker compose down --rmi local

bench:
	npm run bench:run

# Per-symbol targets: make start-sol, make logs-btc, etc.
# Any symbol works — docker compose errors if the service doesn't exist.
start-%:
	docker compose up -d --build mm-$*

stop-%:
	docker compose stop mm-$*

restart-%:
	docker compose stop mm-$*
	docker compose up -d --build mm-$*

logs-%:
	docker compose logs -f mm-$*

monitor-%:
	npm run monitor -- $*

position-log-%:
	tail -f logs/$$(echo $* | tr A-Z a-z)*-position.log

balance-log-%:
	tail -f logs/$$(echo $* | tr A-Z a-z)*-balance.log
