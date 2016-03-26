# cachepm
Npm install relying on local cache when possible.

**If everything is in your local cache already, you don't even need to be online**

(Note: not published on NPM yet -- need to clean stuff up first)

### Install cachepm
```sh
npm install -g cachepm
```

### Use cachepm
Navigate to the node project where you would normally do `npm install`. Now just do `cachepm`. Done.

If you have everything already downloaded and in your npm cache, then it'll be really quick. It will use npm to download anything that isn't already in your cache.

Yes. It's that quick. You've already downloaded everything once. Why shouldn't it be quick?
