.PHONY: build start stop restart logs ps clean cleanall clean-logs bench

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

cleanall:
	docker compose down --rmi local
	rm -f logs/*.log

clean-logs:
	rm -f logs/*.log

bench:
	npm run bench:run

# Per-symbol targets: make start-sol, make logs-btc, etc.
# Any symbol works — docker compose errors if the service doesn't exist.
start-%:
	docker compose up -d --build mm-$*

close-start-%:
	MM_ARGS=--close-position docker compose up -d --build mm-$*

clean-%:
	docker compose rm -sf mm-$*

stop-%:
	docker compose stop mm-$*

restart-%:
	docker compose stop mm-$*
	docker compose up -d --build mm-$*

logs-%:
	docker compose logs -f mm-$*

reserve-actions-%:
	npm run reserve-actions -- $*

monitor-zo-%:
	npm run monitor -- zo $*

monitor-hl-%:
	npm run monitor -- hyperliquid $*

position-log-%:
	tail -f logs/$$(echo $* | tr A-Z a-z)*-position.log

balance-log-%:
	tail -f logs/$$(echo $* | tr A-Z a-z)*-balance.log
