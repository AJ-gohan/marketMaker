 // ##### VARIABLES #####
const token = 'Token';
const symbol = 'BTCUSD';
const order_margin = 0.01;
const maximum_exposure = 0.1;
const spread_short = 0.3;
const spread_long = 0.2;
const leverage = 10;

// ##### REQUIRES #####
const FoxHttps = require('foxhttps');
const FoxSocket = require('foxsocket');

 // ##### VARIABLES #####
var foxSocket = null;
var foxHttps = new FoxHttps(token);
var last_update = 0;
var index_poll = null;
var index_price = null;
var market = null;
var user = null;
var long_order = null;
var short_order = null;
var balance_locked = null;
var balance_unlocked = null;


start();

/*
 * ##### FUNCTIONS #####
 */

function start() {
	console.log('Establishing Connection...');
	foxSocket = new FoxSocket(function () {
				console.log('Connected!');

				console.log('Updating BTC market..');
				foxHttps.marketGet('symbol=' + symbol, function (market_get) {
					if (market_get.error === false) {
						market = market_get.response;

						console.log('Checking API.');
						foxHttps.userGet('currency=' + market.currency, function (user_get) {
							if (user_get.error === false) {
								user = user_get.response;

								//Fetch the index price every X seconds. updateIndex() also calls adjustOrdersAndPositions()
								updateIndex();
								index_poll = setInterval(function () {
									updateIndex();
								}, 60 * 1000);

								//Reacts to order changes and executions in real-time
								foxSocket.subscribeToChannel("USER_" + user.user_id, function (data) {
									if(data.currency == market.currency) adjustOrdersAndPositions();
								}, null, null);
							} else {
								console.error(user_get.error_code);
								process.exit(1);
							}
						});
					} else {
						console.error(market_get.error_code);
						process.exit(1);
					}
				});

			}, function (message) {
				//Websocket response handler
				//console.log(message);
			},
			function (event) {
				//Websocket close
				console.error('Lost connection to websocket server.');
				process.exit(1);
			}, function (event) {
				//Websocket error
				console.error('Websocket error.');
				console.error(event);
				process.exit(1);
			}
	);		//websocket
}				//start

function updateIndex() {
		foxHttps.marketIndexHistory('symbol=' + symbol + '&limit=1', function (fox_index_history) {
		if (fox_index_history.error === false) {
			index_price = Number(fox_index_history.response[0].index_price);
		  console.log(`index: (${index_price})`);



			adjustOrdersAndPositions();
		} else {
			console.error(fox_index_history.error_code);
		}
	});
}

function adjustOrdersAndPositions() {
	var timestamp = new Date().getTime();

	/* Throttle runs to avoid an endless loop.
	   All changes will trigger an update in the USER_ID Websocket channel (that calls this function)
	 */
	if (index_price !== null && last_update < timestamp - 5 * 1000) {
		last_update = timestamp;

		var ask_price = roundToValidMarketPrice(index_price * (1 + spread_short / 100));
		var bid_price = roundToValidMarketPrice(index_price * (1 - spread_long / 100));

		var spread_short_$ = ask_price - index_price;
		var spread_long_$ = index_price - bid_price;

		console.log(`short:${ask_price}:+${spread_short_$}$:(${spread_short}%)`);
		console.log(`long:${bid_price}:-${spread_long_$}$:(${spread_long}%)`);


		foxHttps.userOverview('currency=' + market.currency, function (user_overview) {

			if (user_overview.error === false) {
				balance_locked = Number(user_overview.response.balance_locked);
				balance_unlocked = Number(user_overview.response.balance_unlocked);
				var total = Math.ceil((balance_locked + balance_unlocked) * 10000);

				//Close all orders
				ordersClose(Object.keys(user_overview.response.orders), function () {
					var position_ids = {
						'LONG': [],
						'SHORT': [],
					};
					var positions_margin = {
						'LONG': 0,
						'SHORT': 0,
					};

					for (var position_id in user_overview.response.positions) {
						var direction = user_overview.response.positions[position_id].direction;

						positions_margin[direction] += Number(user_overview.response.positions[position_id].margin);
						position_ids[direction].push(position_id);


					}

					var exposure = Math.abs(positions_margin['LONG'] - positions_margin['SHORT']);


					//Take Profits are Limit orders
					positionsEditTakeProfit(position_ids['LONG'], ask_price, function () {
					positionsEditTakeProfit(position_ids['SHORT'], bid_price, function () {

							if (exposure < maximum_exposure) {
								var order_margin_long = Math.max(order_margin - positions_margin['SHORT'], 0);
						  	var order_margin_short = Math.max(order_margin - positions_margin['LONG'], 0);



								orderCreate(symbol, order_margin_short, 'SHORT', leverage, 'LIMIT', ask_price, index_price);
								orderCreate(symbol, order_margin_long, 'LONG', leverage, 'LIMIT', bid_price, index_price);

							}

							//Merge positions regularly to avoid hundreds of open positions
							var merge_position_ids = {};
							for (var merge_position_id in user_overview.response.positions) {
								var merge_leverage = user_overview.response.positions[merge_position_id].leverage;

								if (!merge_position_ids.hasOwnProperty(merge_leverage)) merge_position_ids[merge_leverage] = [];

								merge_position_ids[merge_leverage].push(merge_position_id);
							}

							for (var merge_leverage in merge_position_ids) {
								if (merge_position_ids[merge_leverage].length > 1) positionsMerge(merge_position_ids[merge_leverage]);

							}
						});
					});
				});
			} else {
				console.error(user_overview.error_code);
			}
		});
	}
}

//Rounds a float value to an "allowed" price.
function roundToValidMarketPrice(price) {
	var multiplier = Math.pow(10, Number(market.decimals));
	return Math.round(price * multiplier) / multiplier;
}


function positionsEditTakeProfit(position_ids, take_profit_price, callback_function) { //add: read orderbook for better tp
	if (position_ids.length > 0) {
		//player.play('sounds/door_bell.mp3');
		console.log('Open Position Detected!')
		foxHttps.positionEdit('position_id=' + position_ids.pop() + '&take_profit=' + index_price, function (response) {


			positionsEditTakeProfit(position_ids, take_profit_price , callback_function);
		});
	} else {
		callback_function();
		}
}

function orderCreate(symbol, margin, direction, leverage, order_type, limit_price, index_price) {  
	if (margin >= Number(market.minimum_margin)) {

		foxHttps.orderCreate('symbol=' + symbol + '&margin=' + margin + '&direction=' + direction + '&leverage=' + leverage + '&order_type=' + order_type + '&limit_price=' + limit_price + '&take_profit=' + index_price, function (response) {  //NOTE:take_profit
			if (response.error) console.error(response.error_code);
		});
	}
}

function ordersClose(order_ids, callback_function) {
	if (order_ids.length > 0) {
		foxHttps.orderClose('order_id=' + order_ids.pop(), function (response) {

			ordersClose(order_ids, callback_function);
		});
	} else {
		callback_function();
	}
}

function positionsMerge(position_ids) {
	foxHttps.positionMerge('position_ids=' + position_ids.join(','), function (response) {
		if (response.error) console.error(response.error_code);
	});
}
