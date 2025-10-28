1.properties.json response cookies - get Tango-DeviceId using nothing
2.check-in.json   response cookies - get Tango-RT       using Tango-DeviceId
3.web.json        response cookies - get Tango-ST       using Tango-RT
4.tokenData.json  response cookies - get tt,ttu,tte     using Tango-ST

now, because we are anonymous, we can just start from Tango-DeviceId again if the refresh token somehow fails.

the flow now is the same because we have tt,ttu,tte,Tango-ST

