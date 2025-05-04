
all: build

build:
	npx tsc

publish:
	npm publish --access public