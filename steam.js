let key = "";

function getListForPlayer(id, done) {
	var settings = {
	  "url": "http://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/",
	  "method": "GET",
	  "headers": {
	    "cache-control": "no-cache",
	    "Access-Control-Allow-Origin": "*"
	  },
		"crossDomain": true,
		"data": {
			"key": key,
			"steamid": id, 
			"include_appinfo": 1
		},
		"success": function(data) {
			console.log(data);
		},
		"error": function(err) {
			console.log(err);
		}
	}

	$.ajax(settings);
}

function getNameForGame(id) {

}
